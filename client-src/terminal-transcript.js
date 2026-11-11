// Readable, non-interactive rendering of already-saved terminal bytes.
// A fullscreen Agent viewport replaces its alternate screen and cannot provide
// line-scrollback for prior responses. Keep this passive text projection;
// never alter live PTY mouse mode or send vt protocol replies for observation.
import Headless from '@xterm/headless';

export async function replayTranscript(read, { isStopped = () => false } = {}) {
  let offset = 0;
  let frames = 0;
  while (!isStopped() && frames++ < 32) {
    const result = await read({ offset, waitMs: 0 });
    if (isStopped()) return { text: '', archived: false };
    if (result.archivedText) return { text: result.data, archived: true };
    if (result.data) {
      offset = result.nextOffset;
      return { text: await projectTerminal(result.data), archived: false };
    }
    if (!result.hasMore || result.exited) break;
  }
  return { text: '', archived: false };
}

export async function projectTerminal(data, cols = 110, rows = 28) {
  const term = new Headless.Terminal({ cols, rows, scrollback: 8000, allowProposedApi: true });
  let alternate = '';
  const onData = term.onData(() => {});
  const leaveAlt = term.parser.registerCsiHandler({ prefix: '?', final: 'l' }, params => {
    if (params.some(value => value === 47 || value === 1047 || value === 1049)) {
      alternate = visibleText(term.buffer.alternate);
    }
    return false;
  });
  try {
    await new Promise(resolve => term.write(data, resolve));
    // The primary buffer contains the actual normal-buffer transcript (not a
    // newly activated blank alternate screen). Fall back to the last readable
    // Agent screen, rather than claiming there is no available content to view.
    const primary = visibleText(term.buffer.normal).trim();
    return primary || alternate.trim() || visibleText(term.buffer.active).trim();
  } finally {
    leaveAlt.dispose();
    onData.dispose();
    term.dispose();
  }
}

function visibleText(buffer) {
  const lines = [];
  for (let row = 0; row < buffer.length; row++) {
    lines.push(buffer.getLine(row)?.translateToString(true) || '');
  }
  while (lines.length && !lines.at(-1).trim()) lines.pop();
  return lines.join('\n');
}
