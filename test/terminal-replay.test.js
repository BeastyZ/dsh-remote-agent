import test from 'node:test'
import assert from 'node:assert/strict'
import Headless from '@xterm/headless'
import { replayOutput } from '../client-src/terminal-replay.js'
import { createTerminalInput } from '../client-src/terminal-input.js'
import { TerminalSession } from '../host/terminal.js'

const DA = '\x1b[c\x1b[>c'
const DA_RESPONSES = ['\x1b[?1;2c', '\x1b[>0;276;0c']
function terminal() {
  const term = new Headless.Terminal({ cols: 120, rows: 40, scrollback: 8000 })
  const forwarded = []
  const input = createTerminalInput(term, data => forwarded.push(data))
  const remote = new TerminalSession({ id: 't-123456abcdef', hostId: 'probe', title: 'probe', cwd: '/working' })
  return { term, forwarded, input, remote }
}

test('history never responds to DA; live output responds normally', async () => {
  const { term, forwarded, remote, input } = terminal()
  remote.push('old output\r\n' + DA)
  const { offset } = await replayOutput({ term, read: ({ offset, waitMs }) => remote.read(offset, waitMs), isStopped: () => false })
  assert.deepEqual(forwarded, [], 'historical DA never uploads')
  remote.push(DA)
  input.finishReplay()
  const result = await remote.read(offset, 0)
  assert(result.data.includes(DA))
  await new Promise(resolve => term.write(result.data, resolve))
  assert.deepEqual(forwarded, DA_RESPONSES)
  input.dispose()
  term.dispose()
})
