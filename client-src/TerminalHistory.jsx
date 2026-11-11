import { React, h, t } from './runtime.js';
import { replayTranscript } from './terminal-transcript.js';
import { IconButton, Button } from './ui.jsx';

const rememberedHistoryPositions = new Map();

// A terminal emulator has no portable way to scroll back a fullscreen TUI:
// alternate-screen bytes replace the viewport. This read-only surface presents
// the saved primary transcript, or the last visible screen if no such primary
// text exists. It never sends user input or terminal query responses.
export function TerminalHistory({ session, rpc, onClose }) {
  const [text, setText] = React.useState('');
  const [error, setError] = React.useState('');
  const [loading, setLoading] = React.useState(true);
  const [previousScroll, setPreviousScroll] = React.useState(null);
  const [reviewingBeginning, setReviewingBeginning] = React.useState(false);
  const scrollRef = React.useRef(null);
  const [savePosition] = React.useState(rememberedHistoryPositions.get(session.id) ?? -1);
  const scrollTo = top => { scrollRef.current?.scrollTo({ top }); };

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const result = await replayTranscript(params => rpc('term.read', { id: session.id, ...params }), { isStopped: () => cancelled });
        if (!cancelled) setText(result.text);
      } catch (caught) { if (!cancelled) setError(caught.message); }
      finally { if (!cancelled) setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [session.id, rpc]);
  React.useLayoutEffect(() => {
    if (!loading && scrollRef.current) {
      const last = savePosition < 0 ? scrollRef.current.scrollHeight : savePosition;
      scrollRef.current.scrollTop = last;
    }
  }, [loading, session.id, savePosition]);
  const remember = () => {
    if (scrollRef.current) rememberedHistoryPositions.set(session.id, scrollRef.current.scrollTop);
    setPreviousScroll(scrollRef.current?.scrollTop || 0);
  };
  const review = () => { remember(); setReviewingBeginning(true); scrollRef.current?.scrollTo({ top: 0 }); };
  const restore = () => {
    setReviewingBeginning(false);
    scrollTo(previousScroll || 0);
    setPreviousScroll(null);
  };

  return h('div', { className: 'ra-history-backdrop' },
    h('section', { className: 'ra-history-panel', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('terminal.history') },
      h('div', { className: 'ra-history-header' },
        h('div', { className: 'ra-history-heading' },
          h('strong', null, t('terminal.history')),
          h('span', { className: 'ra-history-subtitle' }, session.title)),
        h(IconButton, { title: t('terminal.backToLive'), onClick: onClose }, '×')),
      h('div', { className: 'ra-history-hint' }, t('terminal.historyHint')),
      h('div', { className: 'ra-history-actions' },
        !reviewingBeginning ? h(Button, { disabled: loading, onClick: review }, t('terminal.top')) : null,
        reviewingBeginning && previousScroll !== null ? h(Button, { onClick: restore }, t('terminal.returnToReview')) : null,
        h(Button, { disabled: loading || reviewingBeginning, onClick: () => { setReviewingBeginning(false); scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight }); } }, t('terminal.bottom'))),
      h('div', {
        ref: scrollRef,
        className: 'ra-history-scroll', tabIndex: 0,
        onScroll: event => { rememberedHistoryPositions.set(session.id, event.currentTarget.scrollTop); },
        role: 'log', 'aria-readonly': true,
        style: { scrollbarWidth: 'thin', scrollbarColor: 'var(--dsw-alias-label-secondary) transparent' },
      },
        loading ? h('span', { className: 'ra-muted' }, t('misc.loading')) : null,
        error ? h('span', { className: 'ra-file-banner is-error' }, error) : null,
        h('pre', { className: 'ra-history-text' }, text || (loading ? '' : t('terminal.noHistory')))),
      h('div', { className: 'ra-history-footer' },
        h(Button, { variant: 'primary', onClick: onClose }, t('terminal.backToLive')))));
}
