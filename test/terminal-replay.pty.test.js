// Opt-in real-SSH test; see the command in README. It opens a clean shell,
// never attaches to a user's terminal. Run node --test --test-name-pattern
// "real SSH" test/terminal-replay.pty.test.js with DSH_TEST_SSH_ALIAS.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import os from 'node:os'
import Headless from '@xterm/headless'
import { TerminalSession } from '../host/terminal.js'
import { replayOutput } from '../client-src/terminal-replay.js'
import { createTerminalInput } from '../client-src/terminal-input.js'

const require = createRequire(import.meta.url)
const pty = require('node-pty')
const alias = process.env.DSH_TEST_SSH_ALIAS
const DA = '\x1b[c\x1b[>c'

test('real SSH shell receives zero replay DA and one response per live DA', { skip: !alias || os.platform() !== 'darwin', timeout: 25000 }, async () => {
  const child = pty.spawn('/usr/bin/ssh', ['-tt', '-o', 'BatchMode=yes', alias, 'bash --noprofile --norc -i'], { cols: 100, rows: 28, env: process.env })
  const history = new TerminalSession({ id: 't-123456abcdef', hostId: 'probe', title: 'PTY replay test', cwd: '/tmp' })
  child.onData(data => history.push(data))
  const term = new Headless.Terminal({ cols: 100, rows: 28, scrollback: 8000 })
  const input = createTerminalInput(term, data => child.write(data))
  const settle = () => new Promise(resolve => setTimeout(resolve, 900))
  try {
    await settle()
    const before = history.total
    child.write(DA)
    await settle()
    const liveOffset = history.total
    assert((await history.read(before, 0)).data.length > 0)
    history.read(liveOffset, 0)
    // A separately stored query makes this exactly the production replay path.
    const saved = new TerminalSession({ id: 't-abcdef123456', hostId: 'probe', title: 'probe', cwd: '/working' })
    saved.push('saved-history\r\n' + DA)
    await replayOutput({ term, read: ({ offset, waitMs }) => saved.read(offset, waitMs), isStopped: () => false })
    const checkpoint = history.total
    await settle()
    assert.equal(history.total, checkpoint, 'history must not trigger remote protocol responses')
    input.finishReplay()
    history.read(history.total, 0)
    const realTime = new TerminalSession({ id: 't-abcdefabcdef', hostId: 'probe', title: 'probe', cwd: '/working' })
    child.onData(data => realTime.push(data))
    const probeBefore = realTime.total
    child.write(DA)
    for (let i = 0; i < 30 && realTime.total < probeBefore; i++) await new Promise(resolve => setTimeout(resolve, 100))
    await settle()
    await new Promise(resolve => term.write(realTime.buffer.slice(probeBefore - realTime.start), resolve))
    await settle()
    assert(realTime.total > probeBefore, `expected fresh PTY query response, got ${JSON.stringify(realTime.buffer)}`);
  } finally {
    input.dispose()
    term.dispose()
    try { child.kill() } catch { /* test process cleanup */ }
  }
})
