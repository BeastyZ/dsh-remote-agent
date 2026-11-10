import { React, h, t } from './runtime.js';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { CanvasAddon } from '@xterm/addon-canvas';
import { replayOutput } from './terminal-replay.js';
import { createTerminalInput } from './terminal-input.js';

function themeFromPage() {
  const style = getComputedStyle(document.documentElement);
  const read = (name, fallback) => {
    const value = style.getPropertyValue(name).trim();
    return value || fallback;
  };
  return {
    background: read('--dsw-alias-bg-base', '#101418'),
    foreground: read('--dsw-alias-label-primary', '#e6e8eb'),
    cursor: read('--dsw-alias-brand-primary', '#5b9dff'),
    cursorAccent: read('--dsw-alias-bg-base', '#101418'),
    selectionBackground: 'rgba(90, 140, 255, 0.28)',
    black: '#1b1f24', red: '#f07178', green: '#7ee787', yellow: '#e3b341',
    blue: '#79b8ff', magenta: '#d2a8ff', cyan: '#76e3ea', white: '#d7dde3',
    brightBlack: '#6b7785', brightRed: '#ff8b92', brightGreen: '#9be9a8',
    brightYellow: '#f2cc60', brightBlue: '#a5d6ff', brightMagenta: '#e2c5ff',
    brightCyan: '#a7f3f8', brightWhite: '#f5f7fa',
  };
}

export function TerminalView({ session, rpc, active, onExited, onReconnect, onRestart, onOutput }) {
  const hostRef = React.useRef(null);
  const termRef = React.useRef(null);
  const [status, setStatus] = React.useState(session.state || 'running');
  const [exitCode, setExitCode] = React.useState(session.exitCode ?? null);

  React.useEffect(() => {
    const node = hostRef.current;
    if (!node) return undefined;
    const term = new Terminal({
      cols: session.cols || 100,
      rows: session.rows || 26,
      disableStdin: session.state !== 'running',
      fontFamily: 'ui-monospace, SFMono-Regular, "JetBrains Mono", Menlo, Consolas, monospace',
      fontSize: 13,
      lineHeight: 1.22,
      scrollback: 8000,
      cursorBlink: true,
      convertEol: false,
      allowTransparency: false,
      theme: themeFromPage(),
    });
    termRef.current = term;
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(node);
    // The DOM renderer lays out text spans and clips each row. Font fallback
    // and accumulated span widths can cut a final CJK glyph even with ample
    // space before the scrollbar. Canvas draws at terminal cell coordinates.
    const canvas = new CanvasAddon();
    term.loadAddon(canvas);
    let stopped = false;
    let offset = 0;
    let pendingSize = null;
    let sendingSize = false;
    let sentSize = '';
    let resizeChain = Promise.resolve();
    const syncSize = (cols, rows) => {
      pendingSize = { cols, rows };
      if (sendingSize) return resizeChain;
      sendingSize = true;
      resizeChain = (async () => {
        try {
          while (!stopped && pendingSize) {
            const size = pendingSize;
            pendingSize = null;
            const key = `${size.cols}:${size.rows}`;
            if (key === sentSize) continue;
            await rpc('term.resize', { id: session.id, ...size });
            sentSize = key;
          }
        } finally {
          sendingSize = false;
        }
      })();
      return resizeChain;
    };
    const resize = () => {
      if (stopped || session.state !== 'running' || node.clientWidth === 0 || node.clientHeight === 0) return Promise.resolve();
      try {
        // FitAddon accounts for xterm's padding and scrollbar. Use its full
        // fit path, which also clears the renderer when the geometry changes.
        fit.fit();
        const screen = node.querySelector('.xterm-screen');
        const viewport = node.querySelector('.xterm-viewport');
        if (screen && viewport && term.cols > 1) {
          const grid = screen.getBoundingClientRect();
          const view = viewport.getBoundingClientRect();
          const cellWidth = grid.width / term.cols;
          // Check real layout as well: overlay scrollbars, zoom and fractional
          // cell widths must leave at least 12px beyond the final text cell.
          const available = Math.max(0, view.left + viewport.clientWidth - grid.left - 12);
          if (cellWidth > 0 && grid.width > available) {
            term.resize(Math.max(2, Math.floor(available / cellWidth)), term.rows);
          }
        }
      } catch { return Promise.resolve(); /* container not laid out yet */ }
      if (term.cols > 1 && term.rows > 1) {
        return syncSize(term.cols, term.rows).catch(() => {});
      }
      return Promise.resolve();
    };
    const raf = requestAnimationFrame(resize);
    const late = setTimeout(resize, 120);
    const later = setTimeout(resize, 650);
    const observer = new ResizeObserver(resize);
    observer.observe(node);
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(resize).catch(() => {});
    }
    let writeChain = Promise.resolve();
    const send = (data) => {
      // xterm delivers a paste as one large onData; split it so the Host's
      // per-request cap never rejects a paste, and keep the order intact.
      for (let offset = 0; offset < data.length; offset += 8192) {
        const chunk = data.slice(offset, offset + 8192);
        writeChain = writeChain
          .then(() => rpc('term.write', { id: session.id, data: chunk }))
          .catch(() => {});
      }
    };
    const input = createTerminalInput(term, send);

    (async function poll() {
      if (document.fonts?.ready) await document.fonts.ready.catch(() => {});
      if (stopped) return;
      canvas.clearTextureAtlas();
      await resize();
      try {
        const replay = await replayOutput({
          term,
          read: (params) => rpc('term.read', { id: session.id, ...params }),
          onOutput: (text) => onOutput?.(session.id, text),
          isStopped: () => stopped,
        });
        offset = replay.offset;
        input.finishReplay();
        while (!stopped) {
          try {
            const result = await rpc('term.read', { id: session.id, offset, waitMs: 6000 });
            if (stopped) break;
            if (result.data) {
              term.write(result.data);
              offset = result.nextOffset;
              onOutput?.(session.id, result.data);
            }
            if (result.exited) {
              setStatus(result.state || 'exited');
              term.options.disableStdin = true;
              setExitCode(result.exitCode ?? null);
              onExited?.(session.id, result);
              break;
            }
          } catch (error) {
            if (stopped) break;
            if (error && /not found|closed/i.test(error.message || '')) {
              setStatus('exited');
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, 1200));
          }
        }
      } catch (error) {
        if (!stopped && error && /not found|closed/i.test(error.message || '')) setStatus('exited');
      }
    })();

    if (active) term.focus();
    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
      clearTimeout(late);
      clearTimeout(later);
      observer.disconnect();
      input.dispose();
      term.dispose();
      termRef.current = null;
    };
  }, [session.id]);

  React.useEffect(() => {
    if (active) setTimeout(() => termRef.current?.focus(), 30);
  }, [active, session.id]);

  return h('div', { className: 'ra-term-wrap' + (session.state !== 'running' ? ' is-archived' : '') },
    h('div', { ref: hostRef, className: 'ra-term' }),
    status !== 'running'
      ? h('div', { className: 'ra-term-saved' },
        h('div', { className: 'ra-term-saved-copy' },
          h('strong', null, t(status === 'detached' && !session.autoReconnectError ? 'sessions.connecting' : status === 'detached' ? 'sessions.detached' : status === 'saved' ? 'sessions.saved' : 'sessions.exited')),
          h('span', null, t(session.persistent ? (session.autoReconnectError ? 'sessions.autoFailed' : 'sessions.autoHint') : 'sessions.savedHint')),
          exitCode !== null ? h('span', null, 'exit code ' + exitCode) : null),
        session.persistent && onReconnect ? h('button', { type: 'button', className: 'ra-btn ra-btn-primary', title: t('sessions.autoRetryTitle'), onClick: () => onReconnect(session) }, t(session.autoReconnectError ? 'sessions.autoRetry' : 'sessions.reconnect')) : null,
        onRestart ? h('button', { type: 'button', className: 'ra-btn', onClick: () => onRestart(session) }, t('sessions.relaunch')) : null)
      : null);
}
