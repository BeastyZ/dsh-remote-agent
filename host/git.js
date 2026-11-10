// Remote Git support for the workbench.
//
// Emdash's core loop is "one agent per Git worktree, review the diff, merge what
// works". This module provides the same primitives for a remote workspace:
// repository facts, porcelain status, per-file diffs, staging/unstaging,
// committing, and Git worktree creation/removal.
//
// Every command runs through the user's login shell (`bash -lc`) so projects that
// install git outside the non-interactive PATH still work. Paths are single-quoted
// for the remote shell.

import { hashKey, shq } from './util.js'

function safeBranchName(branch) {
  const value = String(branch || '').trim()
  if (!value) return { ok: false, message: 'A branch name is required.' }
  if (value.length > 120) return { ok: false, message: 'The branch name is too long.' }
  if (value.startsWith('-')) return { ok: false, message: 'The branch name cannot start with "-".' }
  if (/[\s~^:?*[\\]/.test(value)) return { ok: false, message: 'The branch name contains an invalid character.' }
  if (value.includes('..') || value.includes('//') || value.endsWith('/') || value.endsWith('.')) {
    return { ok: false, message: 'The branch name is not a valid Git ref.' }
  }
  return { ok: true, value }
}

function dirName(remotePath) {
  const value = String(remotePath || '').replace(/\/+$/, '')
  const index = value.lastIndexOf('/')
  return index <= 0 ? '/' : value.slice(0, index)
}

function baseName(remotePath) {
  const value = String(remotePath || '').replace(/\/+$/, '')
  return value.slice(value.lastIndexOf('/') + 1) || value
}

async function git(pool, host, root, args, { timeoutMs = 30000, maxBytes = 4 * 1024 * 1024 } = {}) {
  const line = `GIT_PAGER=cat GIT_TERMINAL_PROMPT=0 git -C ${shq(root)} ${args.map(shq).join(' ')}`
  const result = await pool.exec(host, `bash -lc ${shq(line)}`, { timeoutMs, maxBytes })
  return result
}

function gitFailure(result, fallback) {
  const text = (result.stderr || result.stdout || result.message || '').trim()
  return {
    ok: false,
    code: result.code || 'GIT',
    message: text || fallback,
    exitCode: result.exitCode,
  }
}

async function repoRoot(pool, host, root) {
  const result = await git(pool, host, root, ['rev-parse', '--show-toplevel'])
  if (!result.ok || !result.stdout.trim()) return { ok: false }
  return { ok: true, root: result.stdout.trim() }
}

export async function info(pool, host, workspacePath) {
  const inside = await git(pool, host, workspacePath, ['rev-parse', '--is-inside-work-tree'])
  if (!inside.ok || inside.stdout.trim() !== 'true') {
    return { ok: true, isRepo: false, root: null, branch: '', entries: [], clean: true, stagedCount: 0, unstagedCount: 0, untrackedCount: 0 }
  }
  const top = await repoRoot(pool, host, workspacePath)
  if (!top.ok) return gitFailure(inside, 'Not a Git repository.')
  const status = await git(pool, host, workspacePath, ['status', '--porcelain=v1', '-z', '--branch', '--untracked-files=all'], { timeoutMs: 45000, maxBytes: 8 * 1024 * 1024 })
  if (!status.ok) return gitFailure(status, 'Cannot read git status.')

  const parts = status.stdout.split('\0')
  let header = ''
  while (parts.length && parts[0] === '') parts.shift()
  if (parts.length && parts[0].startsWith('## ')) header = parts.shift().slice(3)

  let branch = ''
  let upstream = ''
  let ahead = 0
  let behind = 0
  let detached = false
  if (/^HEAD \(no branch\)/.test(header)) {
    detached = true
    branch = 'HEAD'
  } else if (/^No commits yet on /.test(header)) {
    branch = header.replace(/^No commits yet on /, '')
  } else {
    const [branchPart, trackingPart] = header.split('...')
    branch = (branchPart || '').trim()
    if (trackingPart) {
      upstream = trackingPart.replace(/\s*\[.*$/, '').trim()
      const aheadMatch = trackingPart.match(/ahead (\d+)/)
      const behindMatch = trackingPart.match(/behind (\d+)/)
      ahead = aheadMatch ? Number(aheadMatch[1]) : 0
      behind = behindMatch ? Number(behindMatch[1]) : 0
    }
  }

  const entries = []
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index]
    if (!part || part.length < 4) continue
    const x = part[0]
    const y = part[1]
    const path = part.slice(3)
    let origPath = ''
    if (x === 'R' || x === 'C') {
      origPath = parts[index + 1] || ''
      index += 1
    }
    const untracked = x === '?' && y === '?'
    const staged = !untracked && x !== ' ' && x !== '!'
    const unstaged = !untracked && y !== ' ' && y !== '!'
    entries.push({
      path,
      origPath,
      x,
      y,
      untracked,
      staged,
      unstaged,
      status: untracked ? '?' : x !== ' ' ? x : y,
    })
  }
  entries.sort((a, b) => a.path.localeCompare(b.path))
  const stagedCount = entries.filter((entry) => entry.staged).length
  const unstagedCount = entries.filter((entry) => entry.unstaged).length
  const untrackedCount = entries.filter((entry) => entry.untracked).length
  return {
    ok: true,
    isRepo: true,
    root: top.root,
    workspace: workspacePath,
    branch,
    upstream,
    ahead,
    behind,
    detached,
    entries,
    clean: entries.length === 0,
    stagedCount,
    unstagedCount,
    untrackedCount,
  }
}

export async function diff(pool, host, workspacePath, { path, staged = false, untracked = false } = {}) {
  const target = String(path || '').trim()
  if (!target) return { ok: false, code: 'INVALID', message: 'A file path is required.' }
  const args = untracked
    ? ['diff', '--no-index', '--no-color', '--unified=3', '--', '/dev/null', target]
    : ['diff', ...(staged ? ['--cached'] : []), '--no-color', '--unified=3', '--relative', '--', target]
  const result = await git(pool, host, workspacePath, args, { timeoutMs: 45000, maxBytes: 3 * 1024 * 1024 })
  // `git diff --no-index` exits 1 when the files differ; that is success here.
  const acceptable = result.ok || (untracked && result.exitCode === 1)
  if (!acceptable) return gitFailure(result, 'Cannot read the diff.')
  return {
    ok: true,
    path: target,
    staged: Boolean(staged),
    untracked: Boolean(untracked),
    diff: result.stdout,
    truncated: Boolean(result.truncated),
  }
}

export async function stage(pool, host, workspacePath, paths = []) {
  const list = Array.isArray(paths) ? paths.filter(Boolean) : []
  const args = list.length ? ['add', '-A', '--', ...list] : ['add', '-A']
  const result = await git(pool, host, workspacePath, args, { timeoutMs: 45000 })
  if (!result.ok) return gitFailure(result, 'Cannot stage changes.')
  return { ok: true }
}

export async function unstage(pool, host, workspacePath, paths = []) {
  const list = Array.isArray(paths) ? paths.filter(Boolean) : []
  const args = list.length ? ['restore', '--staged', '--', ...list] : ['restore', '--staged', '.']
  const result = await git(pool, host, workspacePath, args, { timeoutMs: 45000 })
  if (!result.ok) {
    // Older Git without `restore`.
    const fallback = await git(pool, host, workspacePath, list.length ? ['reset', '-q', 'HEAD', '--', ...list] : ['reset', '-q', 'HEAD'], { timeoutMs: 45000 })
    if (!fallback.ok) return gitFailure(result, 'Cannot unstage changes.')
  }
  return { ok: true }
}

export async function commit(pool, host, workspacePath, message, { all = false } = {}) {
  const text = String(message || '').trim()
  if (!text) return { ok: false, code: 'INVALID', message: 'A commit message is required.' }
  if (all) {
    const added = await git(pool, host, workspacePath, ['add', '-A'], { timeoutMs: 45000 })
    if (!added.ok) return gitFailure(added, 'Cannot stage changes.')
  }
  const result = await git(pool, host, workspacePath, ['commit', '-m', text], { timeoutMs: 60000 })
  if (!result.ok) return gitFailure(result, 'Cannot create the commit.')
  const hash = await git(pool, host, workspacePath, ['rev-parse', '--short', 'HEAD'], { timeoutMs: 15000 })
  const summary = await git(pool, host, workspacePath, ['log', '-1', '--pretty=%s'], { timeoutMs: 15000 })
  return {
    ok: true,
    hash: hash.ok ? hash.stdout.trim() : '',
    summary: summary.ok ? summary.stdout.trim() : '',
    output: result.stdout,
  }
}

export async function worktreeList(pool, host, workspacePath) {
  const result = await git(pool, host, workspacePath, ['worktree', 'list', '--porcelain'], { timeoutMs: 30000 })
  if (!result.ok) return gitFailure(result, 'Cannot list worktrees.')
  const blocks = result.stdout.split(/\n\n+/)
  const worktrees = []
  for (const block of blocks) {
    if (!block.trim()) continue
    const entry = { path: '', head: '', branch: '', detached: false, bare: false, prunable: false, locked: false }
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('worktree ')) entry.path = line.slice(9)
      else if (line.startsWith('HEAD ')) entry.head = line.slice(5)
      else if (line.startsWith('branch ')) entry.branch = line.slice(7).replace(/^refs\/heads\//, '')
      else if (line === 'detached') entry.detached = true
      else if (line === 'bare') entry.bare = true
      else if (line === 'locked') entry.locked = true
      else if (line === 'prunable') entry.prunable = true
    }
    if (entry.path) worktrees.push(entry)
  }
  return { ok: true, worktrees }
}

export async function worktreeAdd(pool, host, workspacePath, { branch, base = 'HEAD', existing = false } = {}) {
  const valid = safeBranchName(branch)
  if (!valid.ok) return { ok: false, code: 'INVALID', message: valid.message }
  const top = await repoRoot(pool, host, workspacePath)
  if (!top.ok) return { ok: false, code: 'NOT_REPO', message: 'The workspace is not a Git repository.' }
  const home = await pool.exec(host, 'printf %s "$HOME"', { timeoutMs: 15000, maxBytes: 16384 })
  if (!home.ok || !home.stdout.trim()) return { ok: false, code: 'NO_HOME', message: 'Cannot read the remote home directory.' }
  const repoName = baseName(top.root) || 'repo'
  const folder = `${repoName}-${hashKey(top.root)}`
  const safeDir = valid.value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'worktree'
  const worktreePath = `${home.stdout.trim()}/.dsh-remote-agent/worktrees/${folder}/${safeDir}`
  const dir = dirName(worktreePath)

  const prepared = await pool.exec(host, `mkdir -p -- ${shq(dir)} && [ ! -e ${shq(worktreePath)} ]`, { timeoutMs: 20000 })
  if (!prepared.ok) {
    return { ok: false, code: 'EXISTS', message: `The worktree path already exists: ${worktreePath}` }
  }
  const args = existing
    ? ['worktree', 'add', worktreePath, valid.value]
    : ['worktree', 'add', '-b', valid.value, worktreePath, String(base || 'HEAD')]
  const result = await git(pool, host, top.root, args, { timeoutMs: 120000 })
  if (!result.ok) return gitFailure(result, 'Cannot create the worktree.')
  return {
    ok: true,
    path: worktreePath,
    branch: valid.value,
    root: top.root,
    output: result.stdout.trim(),
  }
}

export async function worktreeRemove(pool, host, workspacePath, worktreePath) {
  const target = String(worktreePath || '').trim()
  if (!target) return { ok: false, code: 'INVALID', message: 'A worktree path is required.' }
  const top = await repoRoot(pool, host, workspacePath)
  if (!top.ok) return { ok: false, code: 'NOT_REPO', message: 'The workspace is not a Git repository.' }
  const result = await git(pool, host, top.root, ['worktree', 'remove', '--force', target], { timeoutMs: 60000 })
  if (!result.ok) return gitFailure(result, 'Cannot remove the worktree.')
  await git(pool, host, top.root, ['worktree', 'prune'], { timeoutMs: 30000 })
  return { ok: true, path: target }
}
