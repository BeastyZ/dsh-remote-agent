// Render saved PTY bytes into a read-only transcript, independently of the
// live transport. tmux's leave-alt-screen sequence otherwise restores a blank
// primary buffer when an archived raw stream is replayed in the browser.
import Headless from '@xterm/headless'

function textOf(buffer) {
  const lines = []
  for (let row = 0; row < buffer.length; row++) lines.push(buffer.getLine(row)?.translateToString(true) || '')
  while (lines.length && !lines.at(-1)) lines.pop()
  return lines.length ? lines.join('\r\n') + '\r\n' : ''
}

export async function renderSavedHistory(data, cols, rows) {
  const terminal = new Headless.Terminal({ cols, rows, scrollback: 8000, allowProposedApi: true })
  let lastAlternate = ''
  const handler = terminal.parser.registerCsiHandler({ prefix: '?', final: 'l' }, params => {
    if (terminal.buffer.active.type === 'alternate' && params.some(p => p === 47 || p === 1047 || p === 1049)) {
      const screen = textOf(terminal.buffer.active)
      if (screen.trim()) lastAlternate = screen
    }
    return false // let xterm apply the actual screen switch as usual
  })
  try {
    await new Promise(resolve => terminal.write(data, resolve))
    return lastAlternate && terminal.buffer.active.type === 'normal'
      ? lastAlternate : textOf(terminal.buffer.active)
  } finally {
    handler.dispose()
    terminal.dispose()
  }
}
