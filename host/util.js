import os from 'node:os'
import path from 'node:path'

/** POSIX single-quote a value for a remote shell command line. */
export function shq(value) {
  const s = String(value ?? '')
  return "'" + s.replace(/'/g, "'\\''") + "'"
}

/** Expand a leading ~ in a local path. */
export function expandHome(p) {
  if (typeof p !== 'string' || p === '') return p
  if (p === '~') return os.homedir()
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2))
  return p
}

/** Escape a remote path for use inside a double-quoted shell string. */
export function dq(value) {
  return String(value ?? '').replace(/[\\"`$]/g, '\\$&')
}

export function b64encode(text) {
  return Buffer.from(text, 'utf8').toString('base64')
}

export function b64decode(text) {
  return Buffer.from(String(text || ''), 'base64').toString('utf8')
}

export function hashKey(value) {
  let h = 2166136261
  const s = String(value)
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

export function shortText(text, limit = 600) {
  const s = String(text || '').trim()
  return s.length > limit ? s.slice(0, limit) + '…' : s
}

/** Classify OpenSSH stderr into an actionable error code + message. */
export function classifySshError(stderr, fallback = '') {
  const s = String(stderr || '')
  const lower = s.toLowerCase()
  if (/permission denied|publickey|password|keyboard-interactive|no supported authentication/.test(lower)) {
    return { code: 'AUTH', message: 'SSH authentication failed. Check the key, ssh-agent, or enter the password.' }
  }
  if (/host key verification failed|remote host identification has changed|no .* host key is known/.test(lower)) {
    return { code: 'HOSTKEY', message: 'The remote host key is not trusted (or changed). Verify the fingerprint and update ~/.ssh/known_hosts.' }
  }
  if (/could not resolve hostname|name or service not known|nodename nor servname/.test(lower)) {
    return { code: 'DNS', message: 'The host name could not be resolved.' }
  }
  if (/connection refused/.test(lower)) {
    return { code: 'REFUSED', message: 'The SSH port refused the connection. Is sshd running and is the port correct?' }
  }
  if (/connection timed out|operation timed out|connect timeout/.test(lower)) {
    return { code: 'TIMEOUT', message: 'The SSH connection timed out. Check the network, port, or jump host.' }
  }
  if (/no route to host|network is unreachable/.test(lower)) {
    return { code: 'NETWORK', message: 'The host is unreachable from this machine.' }
  }
  if (/control socket|multiplex|mux_client/.test(lower)) {
    return { code: 'MUX', message: 'The shared SSH connection was lost; retrying with a fresh connection.' }
  }
  if (/command not found|no such file or directory/.test(lower)) {
    return { code: 'COMMAND', message: shortText(s, 300) || 'Remote command failed.' }
  }
  return { code: 'SSH', message: shortText(s, 400) || fallback || 'SSH command failed.' }
}

/** Build a workspace display name from a remote path. */
export function workspaceName(remotePath) {
  const p = String(remotePath || '').replace(/\/+$/, '')
  if (!p) return '/'
  const base = p.slice(p.lastIndexOf('/') + 1)
  return base || '/'
}

/** Relative path from a workspace root, using POSIX separators. */
export function relativeTo(root, target) {
  const r = String(root || '').replace(/\/+$/, '')
  const t = String(target || '')
  if (t === r) return ''
  if (t.startsWith(r + '/')) return t.slice(r.length + 1)
  return t
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}


/** Shell expression for a remote path, expanding a leading ~ to the remote $HOME. */
export function remotePathExpr(value) {
  const p = String(value ?? '')
  if (p === '~') return '"$HOME"'
  if (p.startsWith('~/')) return '"$HOME"/' + shq(p.slice(2))
  return shq(p)
}
