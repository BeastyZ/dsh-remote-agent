// Best-effort observation of interactive agent TUIs. A PTY has no universal
// turn-end event. Require a busy marker followed by a provider's input prompt;
// a quiet terminal alone is never enough, and ordinary shells never notify.
import Headless from '@xterm/headless'

const COMMANDS = ['codex', 'kimi', 'kimi-code', 'claude', 'gemini', 'opencode', 'qwen', 'crush', 'goose', 'copilot', 'dsh']

export function agentKind(command) {
  const text = String(command || '').trim()
  if (!text || /[;&|]/.test(text)) return null
  const words = text.split(/\s+/)
  let executable = words[0]
  if (executable === 'exec' || executable === 'command') executable = words[1] || ''
  const name = executable.split('/').pop()
  return COMMANDS.includes(name) ? name : null
}

export function completionSignal(projectedText, kind) {
  const window = projectedText.split(/\r?\n/).slice(-30).join('\n')
  const busy = /(?:esc(?:ape)?\s*(?:to\s+)?(?:interrupt|cancel)|ctrl\+c\s+(?:to\s+)?interrupt)/i.test(window)
  // Find provider-specific input prompts even if the TUI prefixes the line
  // with another border. Do not infer readiness from a response or shell '$'.
  const prompt = /(?:(?:│|║|╎|\|)[\t ]*)?[>›❯][\t ]*[^\n]*$/im
  const knownPrompt = {
    codex: /(?:ask codex|type your message|context (?:left|remaining))/i,
    claude: /(?:try ['“”`]|\?\s*for shortcuts|shift\+tab)/i,
    gemini: /(?:type your message|\?\s*for help|shift\+tab)/i,
    qwen: /(?:type your message|\?\s*for help|shift\+tab)/i,
    'kimi': /(?:kimi code|\?\s*for help|type your message)/i,
    'kimi-code': /(?:kimi code|\?\s*for help|type your message)/i,
    opencode: /(?:ask anything|\?\s*for help|type your message)/i,
    crush: /(?:ask anything|\?\s*for help|type your message)/i,
    goose: /(?:ask anything|\?\s*for help|type your message)/i,
    copilot: /(?:type your message|\?\s*for help|shift\+tab)/i,
    dsh: /(?:ask anything|\?\s*for help|type your message)/i,
  }[kind]
  // Unknown or revised provider interfaces simply do not send notifications.
  if (!knownPrompt) return { busy: false, ready: false }
  return { busy, ready: !busy && prompt.test(window) && knownPrompt.test(window) }
}

// Project the terminal screen, including its alternate screen (which TUIs usually
// use). Merely searching raw scrollback would find the prompt left behind before
// a turn started and produce an immediate, false completion notification.
export function createCompletionScreen(session) {
  const term = new Headless.Terminal({ cols: Math.max(40, session.cols || 100), rows: Math.max(10, session.rows || 28), scrollback: 100, allowProposedApi: true })
  let projectedTotal = null
  let onDataHandler
  try {
    // Don't parse DA replies on the observing terminal. This is read-only state
    // analysis, not a second input channel into the user's remote program.
    onDataHandler = term.onData(() => {})
  } catch {}
  return {
    get text() {
      const buffer = term.buffer.active
      return Array.from({ length: buffer.length }, (_, index) => buffer.getLine(index)?.translateToString(true) || '').join('\n')
    },
    async project(current) {
      if (current.total < projectedTotal || current.start > projectedTotal) {
        term.reset()
        projectedTotal = null
      }
      const absoluteStart = projectedTotal === null ? Math.max(current.start, current.total - 65536) : projectedTotal
      const data = String(current.buffer || '').slice(Math.max(0, absoluteStart - current.start))
      projectedTotal = current.total
      if (data) await new Promise(resolve => term.write(data, resolve))
      return this.text
    },
    resize(cols, rows) { term.resize(Math.max(40, cols || 100), Math.max(10, rows || 28)) },
    dispose() { onDataHandler?.dispose(); term.dispose() },
  }
}

export class AgentCompletionTracker {
  constructor({ sessions, render = createCompletionScreen, onComplete, quietMs = 4000, intervalMs = 1500, clock = Date, autoStart = true }) {
    Object.assign(this, { sessions, render, onComplete, quietMs, intervalMs, clock })
    this.states = new Map()
    this.pending = Promise.resolve()
    this.timer = null
    if (autoStart) {
      this.timer = setInterval(() => this.observe(), intervalMs)
      this.timer.unref?.()
    }
  }

  observe() {
    // Serial polls avoid overlapping expensive terminal writes on slow links.
    this.pending = this.pending.catch(() => {}).then(() => this.scan())
    return this.pending
  }

  async scan() {
    const live = new Set()
    for (const session of this.sessions() || []) {
      const kind = agentKind(session.command)
      if (!kind) continue
      live.add(session.id)
      await this.inspect(session, kind)
    }
    for (const [id, state] of this.states) {
      if (!live.has(id)) { state.screen?.dispose(); this.states.delete(id) }
    }
  }

  async inspect(session, kind) {
    let state = this.states.get(session.id)
    if (!state || state.generation !== session.generation) {
      state?.screen?.dispose()
      state = { generation: session.generation, initialized: false, wasRunning: false, working: false, lastTotal: null, since: 0, size: '', screen: null }
      this.states.set(session.id, state)
    }
    if (session.state !== 'running') {
      if (state.initialized && state.wasRunning && session.state === 'exited' && state.completedGeneration !== session.generation) {
        state.completedGeneration = session.generation
        await this.onComplete?.({ session, reason: 'exited', exitCode: session.exitCode })
      }
      state.wasRunning = false
      state.working = false
      state.lastTotal = session.total
      return
    }
    const key = `${session.cols}:${session.rows}`
    if (!state.screen || state.size !== key) {
      state.screen?.dispose()
      state.screen = this.render(session)
      state.size = key
      state.initialized = false
    }
    await state.screen.project(session)
    const now = this.clock.now()
    if (!state.initialized) {
      // Reconnecting an existing process presents old screen data. Do not
      // treat either its idle prompt or its saved process death as a new turn.
      state.initialized = true
      state.lastTotal = session.total
      state.since = now
      state.wasRunning = true
      return
    }
    if (state.lastTotal !== session.total) {
      state.lastTotal = session.total
      state.since = now
      return
    }
    const signal = completionSignal(state.screen.text, kind)
    // Watch busy transitions on every poll; otherwise a periodically redrawn
    // TUI could always reset the idle debounce without ever becoming eligible.
    if (signal.busy) { state.working = true; return }
    if (now - state.since < this.quietMs) return
    if (signal.ready && state.working) {
      state.working = false
      state.completedGeneration = session.generation
      await this.onComplete?.({ session, reason: 'idle', exitCode: null })
    } else if (!signal.ready) state.working = false
  }

  dispose() {
    clearInterval(this.timer)
    for (const state of this.states.values()) state.screen?.dispose()
    this.states.clear()
  }
}
