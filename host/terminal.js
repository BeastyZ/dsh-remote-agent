// SSH PTYs with durable local history and optional remote tmux ownership.
import { randomBytes } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'
import os from 'node:os'
import fs from 'node:fs'
import { b64encode, shq } from './util.js'
import { RING_CHARS, TerminalArchive } from './terminal-archive.js'
import { renderSavedHistory } from './terminal-history.js'

const MAX_SESSIONS = 12 // concurrent PTYs, never a limit on saved history
const TMUX_SOCKET = 'dsh-remote-agent'

function remoteBootstrap(cwd, command, title) {
  const lines = [
    `cd -- ${shq(cwd)} 2>/dev/null || { printf '\\033[31m[dsh-remote-agent] cannot cd to %s\\033[0m\\r\\n' ${shq(cwd)}; exit 126; }`,
    `printf '\\033]0;%s\\007' ${shq(title || 'remote')} 2>/dev/null || true`,
    command ? `exec bash -lc ${shq(command)}` : `exec "\${SHELL:-/bin/bash}" -l`,
  ]
  // eval preserves PTY stdin; piping this script into bash breaks agent TUIs.
  return `eval "$(printf %s ${b64encode(lines.join('\n') + '\n')} | base64 -d)"`
}

function dimensions(cols, rows) {
  return { cols: Math.max(2, Math.floor(Number(cols) || 100)), rows: Math.max(2, Math.floor(Number(rows) || 26)) }
}

function tmuxCommand(session) {
  return `${shq(session.tmuxPath)} -L ${TMUX_SOCKET}`
}

export class TerminalSession {
  constructor({ id, hostId, title, cwd, command = '', handle = null, archive, record = {} }) {
    Object.assign(this, { id, hostId, title, cwd, command, archive })
    this.createdAt = record.createdAt || Date.now()
    this.lastSeen = Date.now()
    this.buffer = String(record.buffer || '').slice(-RING_CHARS)
    this.total = Math.max(this.buffer.length, Number(record.total) || 0)
    this.start = this.total - this.buffer.length
    this.cols = dimensions(record.cols, record.rows).cols
    this.rows = dimensions(record.cols, record.rows).rows
    this.tmuxPath = record.tmuxPath || ''
    this.remoteName = record.remoteName || `dsh-${id}`
    this.state = record.state === 'exited' ? 'exited' : (this.tmuxPath ? 'detached' : 'saved')
    this.exitCode = record.exitCode ?? null
    this.exitNote = record.note || ''
    this.generation = Number(record.generation) || 0
    this.waiters = new Set()
    this.checkpointTimer = null
    this.deleted = false
    this.handle = null
    if (handle) this.attach(handle)
  }

  get exited() { return this.state !== 'running' }

  attach(handle) {
    this.handle = handle
    this.state = 'running'
    this.exitCode = null
    this.exitNote = ''
    const decoder = new StringDecoder('utf8')
    handle.output.on('data', chunk => {
      const text = typeof chunk === 'string' ? chunk : decoder.write(chunk)
      if (text) this.push(text)
    })
    handle.output.on('end', () => {
      const tail = decoder.end()
      if (tail) this.push(tail)
    })
    const finish = (code, note) => {
      if (this.handle !== handle) return
      this.handle = null
      if (this.state === 'running') this.state = this.tmuxPath ? 'detached' : 'exited'
      this.exitCode = code
      this.exitNote = note
      this.checkpoint()
      this.flush()
    }
    handle.output.on('error', err => finish(null, err?.message || 'terminal stream error'))
    handle.done.then(outcome => finish(outcome?.exitCode ?? null, 'session exited'))
      .catch(err => finish(null, err?.message || 'session failed'))
    this.checkpoint()
  }

  checkpoint(later = false) {
    if (this.deleted || !this.archive) return
    if (later) {
      if (!this.checkpointTimer) {
        this.checkpointTimer = setTimeout(() => {
          this.checkpointTimer = null
          this.checkpoint()
        }, 1000)
        this.checkpointTimer.unref?.()
      }
      return
    }
    clearTimeout(this.checkpointTimer)
    this.checkpointTimer = null
    try { this.archive.save(this.snapshot()) }
    catch (error) { console.error('[dsh-remote-agent] terminal checkpoint failed:', error.message) }
  }

  snapshot() {
    return {
      ...this.summary(), buffer: this.buffer, total: this.total,
      tmuxPath: this.tmuxPath, remoteName: this.remoteName,
    }
  }

  push(text) {
    this.buffer += text
    this.total += text.length
    if (this.buffer.length > RING_CHARS) this.buffer = this.buffer.slice(-RING_CHARS)
    this.start = this.total - this.buffer.length
    this.checkpoint(true)
    this.flush()
  }

  flush() {
    for (const waiter of Array.from(this.waiters)) {
      if (this.total > waiter.offset || this.exited) {
        this.waiters.delete(waiter)
        clearTimeout(waiter.timer)
        waiter.resolve(this.readNow(waiter.offset))
      }
    }
  }

  readNow(offset, maxChars = 65536) {
    const from = Math.max(0, Math.min(offset, this.total))
    const start = Math.max(from, this.start)
    const remaining = this.total - start
    const count = Math.min(remaining, maxChars)
    const data = this.buffer.slice(start - this.start, start - this.start + count)
    return {
      data, nextOffset: start + count, truncated: from < this.start,
      hasMore: remaining > count,
      exited: this.exited, state: this.state, exitCode: this.exitCode,
      note: this.exitNote, generation: this.generation,
    }
  }

  read(offset, waitMs = 8000) {
    this.lastSeen = Date.now()
    if (this.total > offset || this.exited || waitMs <= 0) return Promise.resolve(this.readNow(offset))
    return new Promise(resolve => {
      const waiter = { offset, resolve, timer: null }
      waiter.timer = setTimeout(() => {
        this.waiters.delete(waiter)
        resolve(this.readNow(offset))
      }, Math.min(Math.max(waitMs, 50), 25000))
      waiter.timer.unref?.()
      this.waiters.add(waiter)
    })
  }

  async write(data) {
    this.lastSeen = Date.now()
    if (this.exited || !this.handle) return false
    try { await this.handle.write(String(data)); return true } catch { return false }
  }

  async resize(cols, rows) {
    if (!this.handle || this.exited) return
    const size = dimensions(cols, rows)
    await this.handle.resize(size.cols, size.rows)
    Object.assign(this, size)
    this.checkpoint(true)
  }

  rename(title) {
    const next = String(title || '').trim().slice(0, 120)
    if (!next) return false
    this.title = next
    this.checkpoint()
    return true
  }

  summary() {
    return {
      id: this.id, hostId: this.hostId, title: this.title, cwd: this.cwd,
      command: this.command, createdAt: this.createdAt, state: this.state,
      exitCode: this.exitCode, note: this.exitNote, cols: this.cols, rows: this.rows,
      persistent: Boolean(this.tmuxPath), generation: this.generation,
    }
  }

  async detach() {
    const handle = this.handle
    this.state = this.tmuxPath ? 'detached' : (this.state === 'exited' ? 'exited' : 'saved')
    this.checkpoint() // synchronous checkpoint before any awaited shutdown work
    this.flush()
    if (handle) { try { await handle.terminate() } catch { /* checkpoint remains */ } }
    this.checkpoint()
  }
}

export class TerminalHub {
  constructor(ctx, pool, { archiveDir, migrationFile } = {}) {
    this.ctx = ctx
    this.pool = pool
    this.sessions = new Map()
    this.archive = archiveDir ? new TerminalArchive(archiveDir) : null
    this.operations = new Map()
    this.startingCount = 0
    this.disposed = false
    for (const record of this.archive?.load() || []) this.restore(record)
    if (migrationFile && this.archive && fs.existsSync(migrationFile)) {
      try {
        const migration = JSON.parse(fs.readFileSync(migrationFile, 'utf8'))
        if (!this.archive.hasMigration(migration.id)) {
          this.importHistory(migration.records)
          // A receipt prevents deleted legacy sessions from being resurrected.
          this.archive.markMigration(migration.id)
        }
      } catch (error) {
        console.warn('[dsh-remote-agent] legacy history import failed:', error.message)
      }
    }
  }

  restore(record) {
    if (this.sessions.has(record.id)) return this.sessions.get(record.id)
    const session = new TerminalSession({ ...record, archive: this.archive, record })
    this.sessions.set(session.id, session)
    return session
  }

  // Also used when upgrading from the old in-memory-only implementation.
  importHistory(records) {
    for (const record of records) {
      if (!/^t-[a-f0-9]{12}$/.test(record.id) || typeof record.hostId !== 'string' || typeof record.cwd !== 'string') {
        throw new Error('Invalid terminal history record.')
      }
      if (!this.sessions.has(record.id)) {
        const session = this.restore(record)
        this.archive?.save(session.snapshot())
      }
    }
    return { ok: true, terminals: this.list() }
  }

  list() { return Array.from(this.sessions.values()).map(s => s.summary()) }
  get(id) { return this.sessions.get(id) }
  runningCount() { return Array.from(this.sessions.values()).filter(s => !s.exited).length }

  async spawn(session, host) {
    const remote = session.tmuxPath
      ? `exec ${tmuxCommand(session)} attach-session -t ${shq(session.remoteName)}`
      : remoteBootstrap(session.cwd, session.command, session.title)
    const argv = await this.pool.ptyArgv(host, remote)
    const handle = await this.ctx.subprocess.spawnTerminal({
      argv, cwd: os.homedir(), env: this.pool.ptyEnv(host),
      cols: session.cols, rows: session.rows, terminalType: 'xterm-256color', graceMs: 3000,
    })
    if (this.disposed) { await handle.terminate(); throw new Error('Workbench is shutting down.') }
    session.attach(handle)
    return { ok: true, session: session.summary() }
  }

  async prepareTmux(session, host) {
    const probe = await this.pool.exec(host, `bash -lc ${shq('command -v tmux || true')}`, { timeoutMs: 12000, maxBytes: 4096 })
    if (!probe.ok) return probe
    const executable = probe.stdout.trim().split('\n').pop()
    if (!executable?.startsWith('/')) { session.tmuxPath = ''; return { ok: true } }
    session.tmuxPath = executable
    // Commit the remote identity BEFORE issuing new-session. If SSH/the Host
    // dies while that request is in flight, the next startup can reconcile it
    // with has-session instead of orphaning a successfully created process.
    this.archive?.save(session.snapshot())
    const tmux = tmuxCommand(session)
    // An isolated tmux server prevents user tmux config/session interference.
    const script = `${tmux} -f /dev/null new-session -d -s ${shq(session.remoteName)} -x ${session.cols} -y ${session.rows} ${shq(remoteBootstrap(session.cwd, session.command, session.title))} && ` +
      `${tmux} set-option -g exit-unattached off && ${tmux} set-option -t ${shq(session.remoteName)} destroy-unattached off && ${tmux} set-option -t ${shq(session.remoteName)} status off`
    const result = await this.pool.exec(host, script, { timeoutMs: 12000, maxBytes: 8192 })
    session.checkpoint()
    return result
  }

  async withCapacity(action) {
    if (this.disposed) return { ok: false, code: 'CLOSED', message: 'Workbench is shutting down.' }
    if (this.runningCount() + this.startingCount >= MAX_SESSIONS) {
      return { ok: false, code: 'LIMIT', message: `At most ${MAX_SESSIONS} terminals can be connected at once. Saved sessions are kept.` }
    }
    this.startingCount++
    try { return await action() } finally { this.startingCount-- }
  }

  async create(options) {
    return this.withCapacity(() => this._create(options))
  }

  async _create({ host, cwd, command = '', title = 'terminal', cols = 100, rows = 26 }) {
    if (!host) return { ok: false, code: 'NO_HOST', message: 'Unknown connection.' }
    const conn = await this.pool.ensure(host)
    if (!conn.ok) return conn
    const id = 't-' + randomBytes(6).toString('hex')
    const session = new TerminalSession({ id, hostId: host.id, title, cwd, command, archive: this.archive, record: dimensions(cols, rows) })
    // Persist before launching anything on the server.
    this.archive?.save(session.snapshot())
    this.sessions.set(id, session)
    try {
      const prepared = await this.prepareTmux(session, host)
      if (!prepared.ok) return prepared
      return await this.spawn(session, host)
    } catch (error) {
      session.checkpoint()
      return { ok: false, code: 'SPAWN', message: error.message }
    }
  }

  async exclusive(id, action) {
    const previous = this.operations.get(id) || Promise.resolve()
    const operation = previous.catch(() => {}).then(action)
    this.operations.set(id, operation)
    try { return await operation }
    finally { if (this.operations.get(id) === operation) this.operations.delete(id) }
  }

  async resume(id, host, { restart = false } = {}) {
    return this.exclusive(id, () => this._resume(id, host, restart))
  }

  async _resume(id, host, restart) {
    const session = this.get(id)
    if (!session) return { ok: false, code: 'NO_SESSION', message: 'Terminal not found.' }
    if (!host || host.id !== session.hostId) return { ok: false, code: 'NO_HOST', message: 'Original SSH connection not found.' }
    if (!session.exited) return { ok: true, session: session.summary() }
    return this.withCapacity(() => this.connectSaved(session, host, restart))
  }

  async connectSaved(session, host, restart) {
    const conn = await this.pool.ensure(host)
    if (!conn.ok) return conn
    if (session.tmuxPath && !restart) {
      const result = await this.pool.exec(host, `${tmuxCommand(session)} has-session -t ${shq(session.remoteName)}`, { timeoutMs: 12000, maxBytes: 4096 })
      if (!result.ok) {
        if (result.exitCode !== 1) return result
        return { ok: false, code: 'REMOTE_GONE', message: 'The remote tmux session is no longer available. Saved history is still retained; relaunch explicitly to start a new process.' }
      }
    } else if (!restart) {
      return { ok: false, code: 'RESTART_REQUIRED', message: 'Saved history is available. Relaunch explicitly to start a new process.' }
    } else {
      if (session.tmuxPath) {
        const killed = await this.killRemote(session, host)
        if (!killed.ok) return killed
      }
      session.remoteName = `dsh-${session.id}`
      const prepared = await this.prepareTmux(session, host)
      if (!prepared.ok) return prepared
    }
    // Preserve the saved transcript; separate it from a fresh attach/relaunch.
    session.push('\r\n\x1b[0m\x1b[?25h\r\n[remote-agent: reconnect]\r\n')
    session.generation++
    try { return await this.spawn(session, host) }
    catch (error) { session.checkpoint(); return { ok: false, code: 'SPAWN', message: error.message } }
  }

  async write(id, data) {
    const session = this.get(id)
    if (!session) return { ok: false, code: 'NO_SESSION', message: 'Terminal not found.' }
    return await session.write(data) ? { ok: true } : { ok: false, code: 'CLOSED', message: 'Terminal is not connected.' }
  }

  async resize(id, cols, rows) {
    const session = this.get(id)
    if (!session) return { ok: false, code: 'NO_SESSION', message: 'Terminal not found.' }
    await session.resize(cols, rows)
    return { ok: true }
  }

  async read(id, offset, waitMs) {
    const session = this.get(id)
    if (!session) return { ok: false, code: 'NO_SESSION', message: 'Terminal not found.' }
    if (session.exited) {
      const key = `${session.total}:${session.cols}:${session.rows}`
      if (session.historyKey !== key) {
        session.historyKey = key
        session.historyText = renderSavedHistory(session.buffer, session.cols, session.rows)
      }
      const text = await session.historyText
      const from = Math.max(0, Math.min(Number(offset) || 0, text.length))
      return {
        ok: true, ...session.readNow(session.total),
        data: text.slice(from), nextOffset: text.length, archivedText: true,
      }
    }
    return { ok: true, ...(await session.read(Number(offset) || 0, Number(waitMs) || 0)) }
  }

  rename(id, title) {
    const session = this.get(id)
    if (!session) return { ok: false, code: 'NO_SESSION', message: 'Terminal not found.' }
    if (!session.rename(title)) return { ok: false, code: 'INVALID', message: 'A terminal title is required.' }
    return { ok: true, session: session.summary() }
  }

  async killRemote(session, host) {
    const tmux = tmuxCommand(session)
    // Absent session/server already counts as deleted; transport errors do not.
    const script = `${tmux} has-session -t ${shq(session.remoteName)} 2>/dev/null; code=$?; ` +
      `if [ "$code" = 0 ]; then ${tmux} kill-session -t ${shq(session.remoteName)}; elif [ "$code" = 1 ]; then exit 0; else exit "$code"; fi`
    return this.pool.exec(host, script, { timeoutMs: 12000, maxBytes: 4096 })
  }

  async close(id) {
    return this.exclusive(id, () => this._close(id))
  }

  async _close(id) {
    const session = this.get(id)
    if (!session) return { ok: true }
    if (session.tmuxPath) {
      const host = this.pool.resolveHost(session.hostId)
      if (!host) return { ok: false, code: 'NO_HOST', message: 'Reconnect the original host before deleting its remote session.' }
      const result = await this.killRemote(session, host)
      if (!result.ok) return result
    }
    await session.detach()
    this.archive?.remove(id)
    session.deleted = true
    clearTimeout(session.checkpointTimer)
    this.sessions.delete(id)
    return { ok: true }
  }

  async dispose() {
    if (this.disposed) return
    this.disposed = true
    // Invoke all checkpoints synchronously before yielding to process teardown.
    await Promise.all(Array.from(this.sessions.values()).map(s => s.detach()))
  }
}
