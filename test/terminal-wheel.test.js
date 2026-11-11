import test from 'node:test'
import assert from 'node:assert/strict'
import Headless from '@xterm/headless'
import { handleTerminalWheel } from '../client-src/terminal-wheel.js'

const wheel = (deltaY = -40, extra = {}) => ({ deltaY, deltaMode: 0, preventDefault() { this.cancelled = true }, ...extra })
const write = (term, data) => new Promise(resolve => term.write(data, resolve))

test('normal scrollback moves inside the terminal and consumes wheel at both boundaries', async t => {
  const term = new Headless.Terminal({ cols: 30, rows: 6, scrollback: 120, allowProposedApi: true })
  t.after(() => term.dispose())
  const sent = []
  term.onData(data => sent.push(data))
  await write(term, Array.from({ length: 50 }, (_, i) => `model response ${i}`).join('\r\n') + '\r\n')
  const bottom = term.buffer.active.viewportY
  assert(bottom > 0)
  assert.equal(handleTerminalWheel(wheel(), term), false)
  assert(term.buffer.active.viewportY < bottom)
  for (let i = 0; i < 100; i++) assert.equal(handleTerminalWheel(wheel(), term), false)
  assert.equal(term.buffer.active.viewportY, 0)
  for (let i = 0; i < 100; i++) assert.equal(handleTerminalWheel(wheel(40), term), false)
  assert.equal(term.buffer.active.viewportY, bottom)
  assert.deepEqual(sent, [], 'no remote arrow/input history navigation')
})

test('mouse-aware fullscreen terminal delegates wheel to xterm native mouse protocol without opening a window', async t => {
  const term = new Headless.Terminal({ cols: 80, rows: 10, allowProposedApi: true })
  t.after(() => term.dispose())
  await write(term, '\x1b[?1049h\x1b[?1000h\x1b[?1006hFullscreen Agent')
  assert.equal(term.buffer.active.type, 'alternate')
  assert.equal(term.modes.mouseTrackingMode, 'vt200')
  let opened = 0
  const event = wheel()
  assert.equal(handleTerminalWheel(event, term, { onSavedHistory() { opened++ } }), true)
  assert.equal(opened, 0)
  assert.equal(event.cancelled, undefined, 'xterm native mouse listener handles the event')
  await write(term, '\x1b[?1000l\x1b[?1002h')
  assert.equal(handleTerminalWheel(wheel(40), term), true)
  await write(term, '\x1b[?1002l\x1b[?1003h')
  assert.equal(handleTerminalWheel(wheel(), term), true)
})

test('empty and mouse-disabled alternate terminals never fall through to synthetic arrows, even with modifiers', async t => {
  const term = new Headless.Terminal({ cols: 80, rows: 10, allowProposedApi: true })
  t.after(() => term.dispose())
  const sent = []
  term.onData(data => sent.push(data))
  for (const output of ['', '\x1b[?1049h', '\x1b[?9h']) {
    await write(term, output || ' ')
    for (const extra of [{}, { altKey: true }, { shiftKey: true }]) {
      const event = wheel(-40, extra)
      assert.equal(handleTerminalWheel(event, term), false)
      assert(event.cancelled)
    }
  }
  assert.deepEqual(sent, [])
})

test('asynchronous browser viewport updates cannot process the same wheel twice', () => {
  let count = 0
  const term = { modes: { mouseTrackingMode: 'none' }, buffer: { active: { type: 'normal', baseY: 100, viewportY: 100 } }, scrollLines() { count++ } }
  assert.equal(handleTerminalWheel(wheel(), term), false)
  assert.equal(count, 1)
  assert.equal(handleTerminalWheel(wheel(0), term), false)
  assert.equal(count, 1)
})
