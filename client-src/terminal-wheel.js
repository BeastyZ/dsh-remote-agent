// Let a mouse-aware Agent or our isolated tmux handle real wheel events in
// the current terminal. Never let xterm's no-scrollback fallback manufacture
// arrow keys: that recalls prompts instead of scrolling output.
export function handleTerminalWheel(event, terminal) {
  if (!event.deltaY) return false
  const mouse = terminal.modes.mouseTrackingMode
  if (mouse === 'vt200' || mouse === 'drag' || mouse === 'any') return true

  if (terminal.buffer.active.type === 'normal' && terminal.buffer.active.baseY > 0) {
    terminal.scrollLines(lines(event))
  }
  // Browser xterm scrollLines updates its viewport asynchronously. Always
  // consume the event, including at either boundary, instead of testing for
  // an immediate viewportY change and then processing the wheel twice.
  event.preventDefault?.()
  return false
}

export function lines(event) {
  const amount = event.deltaMode === 1 ? 3 : event.deltaMode === 2 ? 20 : 1
  const magnitude = Math.max(1, Math.round(Math.abs(event.deltaY) / 40) || 1)
  return (event.deltaY < 0 ? -1 : 1) * Math.min(30, magnitude) * amount
}
