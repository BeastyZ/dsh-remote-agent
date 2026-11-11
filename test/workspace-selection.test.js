import test from 'node:test'
import assert from 'node:assert/strict'
import { workspaceSessions, chooseSession, fitsWorkspace } from '../client-src/workspace-selection.js'

const workspaces = [
  { id: 'w-a', hostId: 'server', path: '/work/a' },
  { id: 'w-b', hostId: 'server', path: '/work/b' },
]
const sessions = [
  { id: 'a-session', hostId: 'server', cwd: '/work/a', state: 'running' },
  { id: 'b-session', hostId: 'server', cwd: '/work/b', state: 'running' },
]

test('switching same-host workspace changes terminal list', () => {
  assert.deepEqual(workspaceSessions(sessions, workspaces[0]).map(s => s.id), ['a-session'])
  assert.deepEqual(workspaceSessions(sessions, workspaces[1]).map(s => s.id), ['b-session'])
  assert.deepEqual(workspaceSessions(sessions, workspaces[1]).length, 1)
  assert.equal(fitsWorkspace(sessions[0], workspaces[1]), false)
})

test('unrelated directory gets no current terminal rather than keeping A', () => {
  const current = chooseSession('a-session', null, workspaceSessions(sessions, workspaces[1]))
  assert.equal(current, 'b-session')
  const empty = workspaceSessions(sessions, { id: 'w-empty', hostId: 'server', path: '/work/no-session' })
  assert.deepEqual(empty, [])
  assert.equal(chooseSession('b-session', null, empty), null)
  assert.deepEqual(sessions.map(s => s.id), ['a-session', 'b-session'], 'filter hides, never removes')
})

test('previous workspace remembers its own last active session', () => {
  const memory = new Map([['w-a', 'a-session'], ['w-b', 'b-session']])
  for (const ws of workspaces) {
    assert.equal(chooseSession(memory.get(ws.id), null, workspaceSessions(sessions, ws)), memory.get(ws.id))
  }
})
