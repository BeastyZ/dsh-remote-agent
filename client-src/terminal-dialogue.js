import { lines } from './terminal-wheel.js';

// A full-size xterm in the same terminal stage. The live PTY stays mounted and
// keeps its original input untouched while the saved dialogue is being read.
export function createDialogueScrollback({ read, createView, forward, isStopped = () => false, onLoading = () => {}, labels = { user: 'You', assistant: 'Agent' } }) {
  let view = null;
  let visible = false;
  let pending = null;
  let messages = [];
  let sourceId;
  let before;
  let hasMore = false;
  let unavailableUntil = 0;
  let generation = 0;

  const hide = () => {
    generation++;
    visible = false;
    view?.hide();
  };
  const render = async (initial, amount) => {
    if (!view) view = createView({ onInput(data) { hide(); forward(data); }, onClose: hide });
    const term = view.term;
    const distance = term.buffer.active.baseY - term.buffer.active.viewportY;
    view.show();
    visible = true;
    view.fit?.();
    term.reset();
    const text = messages.map(message => `\x1b[1m${labels[message.role] || message.role}\x1b[0m\r\n${safeText(message.text)}\r\n`).join('\r\n');
    // Grow with loaded dialogue pages instead of silently clipping another
    // fixed number of lines. Two cells per UTF-16 unit plus tab expansion is a
    // conservative row bound for both CJK and narrow terminal widths.
    const rows = text.split('\n').reduce((total, line) => total + Math.max(1, Math.ceil((line.length * 2 + (line.match(/\t/g)?.length || 0) * 6) / Math.max(2, term.cols))), 0);
    term.options.scrollback = Math.max(8000, rows + term.rows);
    await new Promise(resolve => term.write('\x1b[?25l' + text, resolve));
    if (isStopped() || !visible) return;
    if (initial) { term.scrollToBottom(); term.scrollLines(Math.min(-1, amount)); }
    else term.scrollToLine(Math.max(0, term.buffer.active.baseY - distance));
    term.focus?.();
  };
  const load = (initial, amount) => {
    if (pending) return pending;
    const token = generation;
    onLoading(true);
    pending = (async () => {
      try {
        const page = await read(initial ? {} : { before, sourceId });
        if (isStopped() || token !== generation) return;
        if (!page.available || !Array.isArray(page.messages) || !page.messages.length) {
          if (initial) unavailableUntil = Date.now() + 30000;
          return;
        }
        if (!initial && page.sourceId !== sourceId) throw new Error('Dialogue source changed');
        if (!initial && page.hasMore && !(page.before < before)) throw new Error('Dialogue page did not advance');
        messages = initial ? page.messages : [...page.messages, ...messages];
        sourceId = page.sourceId;
        before = page.before;
        hasMore = Boolean(page.hasMore);
        await render(initial, amount);
      } catch {
        // Leave live input usable on read/SSH failures. A later gesture retries.
        if (initial) unavailableUntil = Date.now() + 10000;
      } finally { pending = null; if (!isStopped()) onLoading(false); }
    })();
    return pending;
  };
  return {
    handleLiveWheel(event) {
      if (event.deltaY >= 0 || Date.now() < unavailableUntil) return false;
      if (!pending) load(true, -Math.max(3, Math.abs(lines(event))));
      event.preventDefault?.();
      return true;
    },
    handleHistoryWheel(event) {
      if (!visible || !view) return false;
      event.preventDefault?.();
      if (pending) return false;
      const term = view.term;
      const buffer = term.buffer.active;
      if (event.deltaY > 0 && buffer.viewportY >= buffer.baseY) { hide(); return false; }
      if (event.deltaY < 0 && buffer.viewportY <= 0 && hasMore) load(false, lines(event));
      else term.scrollLines(lines(event));
      return false;
    },
    resize() { if (visible) view?.fit?.(); },
    hide,
    get pending() { return pending; },
    get visible() { return visible; },
    dispose() { generation++; visible = false; view?.dispose(); view = null; },
  };
}

export function safeText(value) {
  return String(value || '')
    .replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-_])/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, '')
    .replace(/\r\n?/g, '\n').replace(/\n/g, '\r\n');
}
