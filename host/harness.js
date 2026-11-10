// Discover agent harnesses installed on the remote host.
//
// "Any harness" means anything the server can execute in a PTY, so discovery is a
// PATH scan for the common CLI names plus a version probe. The launch path is
// independent of this list: a user can always type a custom command.

import { shq } from './util.js'

export const KNOWN_HARNESSES = [
  { id: 'codex', name: 'Codex', command: 'codex', vendor: 'OpenAI' },
  { id: 'kimi', name: 'Kimi Code', command: 'kimi', vendor: 'Moonshot' },
  { id: 'claude', name: 'Claude Code', command: 'claude', vendor: 'Anthropic' },
  { id: 'gemini', name: 'Gemini CLI', command: 'gemini', vendor: 'Google' },
  { id: 'opencode', name: 'OpenCode', command: 'opencode', vendor: 'OpenCode' },
  { id: 'aider', name: 'Aider', command: 'aider', vendor: 'Aider' },
  { id: 'qwen', name: 'Qwen Code', command: 'qwen', vendor: 'Qwen' },
  { id: 'crush', name: 'Crush', command: 'crush', vendor: 'Charm' },
  { id: 'goose', name: 'Goose', command: 'goose', vendor: 'Block' },
  { id: 'amp', name: 'Amp', command: 'amp', vendor: 'Sourcegraph' },
  { id: 'droid', name: 'Droid', command: 'droid', vendor: 'Factory' },
  { id: 'cursor-agent', name: 'Cursor Agent', command: 'cursor-agent', vendor: 'Cursor' },
  { id: 'copilot', name: 'GitHub Copilot CLI', command: 'copilot', vendor: 'GitHub' },
  { id: 'continue', name: 'Continue CLI', command: 'cn', vendor: 'Continue' },
  { id: 'dsh', name: 'DeepSeek Harness', command: 'dsh', vendor: 'DeepSeek' },
]

const BY_COMMAND = new Map(KNOWN_HARNESSES.map((h) => [h.command, h]))
const BINARY_NAMES = KNOWN_HARNESSES.map((h) => h.command)

const SCRIPT = `
export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$HOME/.bun/bin:$HOME/.cargo/bin:$HOME/bin:/usr/local/bin:/opt/homebrew/bin:$PATH"
for c in ${BINARY_NAMES.map((c) => shq(c)).join(' ')}; do
  p=$(command -v "$c" 2>/dev/null) || continue
  v=$( { (command -v timeout >/dev/null 2>&1 && timeout 4 "$c" --version 2>&1) || "$c" --version 2>&1 || true; } | head -n 1 | tr -d '\r' )
  printf '%s\\t%s\\t%s\\n' "$c" "$p" "$v"
done
printf '__DSH_RA_TOOLS__\\n'
for c in git tmux rg rg python3 node docker uv npm; do
  p=$(command -v "$c" 2>/dev/null) && printf '%s\\t%s\\n' "$c" "$p"
done
printf '__DSH_RA_ENV__\\n'
printf '%s\\n' "$SHELL" "$(uname -s)" "$(uname -m)" "$HOME"
`

export async function detectHarnesses(pool, host) {
  const r = await pool.exec(host, `bash -lc ${shq(SCRIPT)}`, { timeoutMs: 90000, maxBytes: 512 * 1024 })
  if (!r.ok && !r.stdout) {
    return { ok: false, code: r.code || 'HARNESS', message: r.message || 'Harness discovery failed.' }
  }
  const [main = '', afterTools = ''] = r.stdout.split('__DSH_RA_TOOLS__')
  const [toolsPart = '', envPart = ''] = afterTools.split('__DSH_RA_ENV__')
  const harnesses = []
  for (const line of main.split(/\r?\n/)) {
    if (!line.trim()) continue
    const [command, path, version] = line.split('\t')
    if (!command || !path) continue
    const known = BY_COMMAND.get(command)
    harnesses.push({
      id: known?.id || command,
      name: known?.name || command,
      vendor: known?.vendor || '',
      command,
      path,
      version: (version || '').trim(),
      installed: true,
      known: Boolean(known),
    })
  }
  harnesses.sort((a, b) => {
    const ai = KNOWN_HARNESSES.findIndex((h) => h.command === a.command)
    const bi = KNOWN_HARNESSES.findIndex((h) => h.command === b.command)
    return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi)
  })
  const tools = {}
  for (const line of toolsPart.split(/\r?\n/)) {
    const [name, path] = line.split('\t')
    if (name && path) tools[name] = path
  }
  const env = envPart.split(/\r?\n/).filter(Boolean)
  return {
    ok: true,
    harnesses,
    tools,
    env: { shell: env[0] || '', os: env[1] || '', arch: env[2] || '', home: env[3] || '' },
    at: Date.now(),
    warnings: r.ok ? [] : [r.message],
  }
}
