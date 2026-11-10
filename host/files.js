// Remote filesystem operations over the shared SSH connection.
//
// Paths are always single-quoted for the remote shell; every command runs under
// the user's login environment exactly like a manual ssh invocation. Listing uses
// GNU find's NUL-separated -printf output, which survives spaces, newlines and
// non-UTF-8 bytes in file names.

import { remotePathExpr, shq } from './util.js'

function fail(res, fallback = 'Remote file operation failed.') {
  return {
    ok: false,
    code: res.code || 'FS',
    message: res.message || fallback,
    exitCode: res.exitCode ?? null,
  }
}

export async function home(pool, host) {
  const r = await pool.exec(host, 'printf %s "$HOME"', { timeoutMs: 15000, maxBytes: 64 * 1024 })
  if (!r.ok) return fail(r, 'Cannot read the remote home directory.')
  return { ok: true, home: r.stdout.trim() }
}

export async function resolvePath(pool, host, remotePath) {
  const r = await pool.exec(host, `cd -- ${remotePathExpr(remotePath)} 2>/dev/null && pwd -P`, { timeoutMs: 15000 })
  if (!r.ok || !r.stdout.trim()) {
    return { ok: false, code: 'NOT_A_DIRECTORY', message: `Not a directory: ${remotePath}` }
  }
  return { ok: true, path: r.stdout.trim() }
}

export async function listDir(pool, host, remotePath) {
  // LS, not FIND. On large / network-mounted directories (e.g. /inspire/hdd),
  // `find -printf` performs a stat per entry and can hang for minutes. `ls -U`
  // streams directory entries without sorting or stat'ing, and the head cap
  // keeps a million-entry directory usable. Type comes from the `/` suffix that
  // `-p` appends for directories (d_type, no extra stat).
  const script = [
    `cd -- ${remotePathExpr(remotePath)} 2>/dev/null || { printf '__DSH_RA_ERR__cd'; exit 3; }`,
    `command ls -U -1pA --quoting-style=literal 2>/dev/null | head -n 2001`,
  ].join('\n')
  const r = await pool.exec(host, script, { timeoutMs: 12000, maxBytes: 3 * 1024 * 1024 })
  if (r.stdout.startsWith('__DSH_RA_ERR__cd')) {
    return { ok: false, code: 'NOT_A_DIRECTORY', message: `Cannot open remote directory: ${remotePath}` }
  }
  if (!r.ok) {
    if (r.code === 'TIMEOUT') {
      return {
        ok: false,
        code: 'TIMEOUT',
        message: 'Directory listing timed out. The remote mount may be slow or unresponsive; try again or pick a different workspace.',
      }
    }
    return fail(r, 'Cannot list the remote directory.')
  }
  const lines = r.stdout.split(/\r?\n/).filter((line) => line !== '')
  const truncated = lines.length > 2000
  if (truncated) lines.length = 2000
  const entries = []
  for (const line of lines) {
    const isDir = line.endsWith('/')
    const name = isDir ? line.slice(0, -1) : line
    if (!name || name === '.' || name === '..') continue
    entries.push({
      name,
      path: remotePath.replace(/\/+$/, '') + '/' + name,
      type: isDir ? 'dir' : 'file',
      size: null,
      mtime: 0,
      mode: '',
    })
  }
  entries.sort((a, b) => {
    if (a.type === 'dir' && b.type !== 'dir') return -1
    if (a.type !== 'dir' && b.type === 'dir') return 1
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
  })
  return { ok: true, path: remotePath, entries, truncated }
}

export async function statPath(pool, host, remotePath) {
  const r = await pool.exec(host, `stat -c '%F\t%s\t%Y\t%a' -- ${remotePathExpr(remotePath)} 2>/dev/null`, { timeoutMs: 15000, maxBytes: 64 * 1024 })
  if (!r.ok || !r.stdout) return { ok: false, code: 'NOT_FOUND', message: `Not found: ${remotePath}` }
  const [kind, size, mtime, mode] = r.stdout.trim().split('\t')
  return {
    ok: true,
    path: remotePath,
    kind: kind || '',
    type: /directory/i.test(kind || '') ? 'dir' : /symbolic link/i.test(kind || '') ? 'symlink' : 'file',
    size: Number(size) || 0,
    mtime: (Number(mtime) || 0) * 1000,
    mode: mode || '',
  }
}

const TEXT_MAX = 4 * 1024 * 1024
const BINARY_MAX = 24 * 1024 * 1024

export async function readFile(pool, host, remotePath, { maxBytes = TEXT_MAX } = {}) {
  const st = await statPath(pool, host, remotePath)
  if (!st.ok) return st
  if (st.type === 'dir') return { ok: false, code: 'IS_DIR', message: 'This path is a directory.' }
  const limit = Math.max(1024, Math.min(Number(maxBytes) || TEXT_MAX, BINARY_MAX))
  if (st.size > limit) {
    return {
      ok: true,
      tooLarge: true,
      size: st.size,
      mtime: st.mtime,
      kind: st.kind,
      message: `File is ${(st.size / 1024 / 1024).toFixed(1)} MB, above the ${(limit / 1024 / 1024).toFixed(1)} MB preview limit.`,
    }
  }
  const r = await pool.exec(host, `base64 < ${remotePathExpr(remotePath)}`, { timeoutMs: 60000, maxBytes: Math.ceil(limit * 1.4) + 65536 })
  if (!r.ok) return fail(r, 'Cannot read the remote file.')
  const base64 = r.stdout.replace(/\s+/g, '')
  let binary = false
  try {
    const head = Buffer.from(base64.slice(0, 16384), 'base64')
    binary = head.includes(0)
  } catch { /* ignore */ }
  const text = binary ? '' : Buffer.from(base64, 'base64').toString('utf8')
  return {
    ok: true,
    path: remotePath,
    size: st.size,
    mtime: st.mtime,
    mode: st.mode,
    kind: st.kind,
    binary,
    base64,
    text,
    truncated: Boolean(r.truncated),
  }
}

export async function writeFile(pool, host, remotePath, base64, { expectedMtime = null, mode = '' } = {}) {
  const expected = expectedMtime === null || expectedMtime === undefined || expectedMtime === ''
    ? ''
    : String(Math.floor(Number(expectedMtime) / 1000))
  const script = [
    `p=${remotePathExpr(remotePath)}`,
    `d=$(dirname -- "$p") || exit 2`,
    `mkdir -p -- "$d" || exit 2`,
    `mode=${shq(mode || '')}`,
    `if [ -e "$p" ]; then`,
    `  if [ -n ${shq(expected)} ] && [ "$(stat -c %Y -- "$p" 2>/dev/null)" != ${shq(expected)} ]; then printf '__DSH_RA_CONFLICT__'; exit 42; fi`,
    `  [ -n "$mode" ] || mode=$(stat -c %a -- "$p" 2>/dev/null)`,
    `fi`,
    `tmp=$(mktemp -- "$d/.dsh-ra.XXXXXX") || exit 43`,
    `base64 -d > "$tmp" || { rm -f -- "$tmp"; exit 44; }`,
    `chmod "\${mode:-644}" "$tmp" 2>/dev/null || true`,
    `mv -f -- "$tmp" "$p" || { rm -f -- "$tmp"; exit 45; }`,
    `stat -c %Y -- "$p"`,
  ].join('\n')
  const r = await pool.exec(host, script, {
    timeoutMs: 60000,
    maxBytes: 128 * 1024,
    input: base64.endsWith('\n') ? base64 : base64 + '\n',
  })
  if (r.stdout.startsWith('__DSH_RA_CONFLICT__') || r.exitCode === 42) {
    return { ok: false, code: 'CONFLICT', message: 'The file changed on the server after you opened it. Reload it before saving.' }
  }
  if (!r.ok) return fail(r, 'Cannot write the remote file.')
  return { ok: true, mtime: (Number(r.stdout.trim()) || 0) * 1000 }
}

export async function mkdir(pool, host, remotePath) {
  const r = await pool.exec(host, `mkdir -p -- ${remotePathExpr(remotePath)} && stat -c %Y -- ${remotePathExpr(remotePath)}`, { timeoutMs: 20000 })
  if (!r.ok) return fail(r, 'Cannot create the remote directory.')
  return { ok: true, path: remotePath, mtime: (Number(r.stdout.trim()) || 0) * 1000 }
}

export async function remove(pool, host, remotePath) {
  const r = await pool.exec(host, `rm -rf -- ${remotePathExpr(remotePath)}`, { timeoutMs: 60000 })
  if (!r.ok) return fail(r, 'Cannot delete the remote path.')
  return { ok: true }
}

export async function rename(pool, host, from, to) {
  const r = await pool.exec(host, `mv -f -- ${remotePathExpr(from)} ${remotePathExpr(to)} && stat -c %Y -- ${remotePathExpr(to)}`, { timeoutMs: 30000 })
  if (!r.ok) return fail(r, 'Cannot rename the remote path.')
  return { ok: true, path: to, mtime: (Number(r.stdout.trim()) || 0) * 1000 }
}

/** Copy or move several sources into one remote directory. */
export async function transfer(pool, host, sources, destDir, { move = false } = {}) {
  const list = Array.isArray(sources) ? sources.filter(Boolean) : []
  if (!list.length) return { ok: false, code: 'INVALID', message: 'Nothing to copy.' }
  const cmd = move ? 'mv -f' : 'cp -a'
  const lines = [`d=${remotePathExpr(destDir)}`, `[ -d "$d" ] || { printf '__DSH_RA_NOTDIR__'; exit 2; }`]
  for (const src of list) lines.push(`${cmd} -- ${remotePathExpr(src)} "$d"/ || exit $?`)
  const r = await pool.exec(host, lines.join('\n'), { timeoutMs: 120000 })
  if (r.stdout.startsWith('__DSH_RA_NOTDIR__')) return { ok: false, code: 'NOT_A_DIRECTORY', message: 'The destination is not a directory.' }
  if (!r.ok) return fail(r, 'Cannot copy the remote path.')
  return { ok: true }
}

export async function searchFiles(pool, host, root, query, { limit = 200 } = {}) {
  const q = String(query || '').trim()
  if (!q) return { ok: true, results: [] }
  const max = Math.max(1, Math.min(Number(limit) || 200, 500))
  const script = [
    `cd -- ${remotePathExpr(root)} 2>/dev/null || exit 2`,
    `if command -v rg >/dev/null 2>&1; then`,
    `  rg --files --hidden -g '!**/.git/**' 2>/dev/null | grep -F -i -- ${shq(q)} | head -n ${max}`,
    `else`,
    `  find . -type f -not -path '*/.git/*' 2>/dev/null | grep -F -i -- ${shq(q)} | head -n ${max}`,
    `fi`,
  ].join('\n')
  const r = await pool.exec(host, script, { timeoutMs: 20000, maxBytes: 2 * 1024 * 1024 })
  if (!r.ok) return fail(r, 'Remote search failed.')
  const results = r.stdout.split(/\r?\n/).filter(Boolean).map((p) => {
    const rel = p.replace(/^\.\//, '')
    return { path: root.replace(/\/+$/, '') + '/' + rel, relative: rel, name: rel.slice(rel.lastIndexOf('/') + 1) }
  })
  return { ok: true, results }
}
