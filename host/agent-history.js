import fs from 'node:fs'
import { b64encode, shq } from './util.js'

const PYTHON = fs.readFileSync(new URL('./agent-history.py', import.meta.url), 'utf8')
const MAX_BYTES = 2 * 1024 * 1024

export async function loadAgentHistory({ pool, host, session, before, sourceId } = {}) {
  if (!pool?.exec || !host || !session?.tmuxPath || !session?.remoteName || !session?.cwd) {
    return { ok: true, available: false, messages: [], source: 'kimi-code', sourceId: sourceId || null, before: 0, hasMore: false, complete: false, reason: 'unsupported' }
  }
  const payload = JSON.stringify({ cwd: String(session.cwd), tmuxPath: String(session.tmuxPath), remoteName: String(session.remoteName), before: before == null ? null : Number(before), sourceId: sourceId || null })
  const encoded = b64encode(PYTHON)
  const command = `python3 -c ${shq(`import base64;exec(compile(base64.b64decode(${JSON.stringify(encoded)}),'agent-history.py','exec'))`)}`
  const result = await pool.exec(host, command, { timeoutMs: 12000, maxBytes: MAX_BYTES, input: payload })
  if (!result?.ok || result.truncated || !result.stdout) return { ok: true, available: false, messages: [], source: 'kimi-code', sourceId: sourceId || null, before: 0, hasMore: false, complete: false, reason: result?.truncated ? 'remote-output-truncated' : 'remote-unavailable' }
  try {
    const value = JSON.parse(String(result.stdout || '').trim())
    return value && typeof value === 'object' ? value : { ok: true, available: false, messages: [], source: 'kimi-code', sourceId: sourceId || null, before: 0, hasMore: false, complete: false, reason: 'invalid-response' }
  } catch {
    return { ok: true, available: false, messages: [], source: 'kimi-code', sourceId: sourceId || null, before: 0, hasMore: false, complete: false, reason: 'invalid-response' }
  }
}

export { MAX_BYTES }
