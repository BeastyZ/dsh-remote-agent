import test from 'node:test';
import assert from 'node:assert/strict';
import Headless from '@xterm/headless';
import { createDialogueScrollback, safeText } from '../client-src/terminal-dialogue.js';

const wheel = deltaY => ({ deltaY, deltaMode: 0, preventDefault() { this.cancelled = true; } });
const visible = term => Array.from({ length: term.rows }, (_, row) => term.buffer.active.getLine(term.buffer.active.viewportY + row)?.translateToString(true) || '').join('\n');

function fixture(t, read) {
  let shown = 0, hidden = 0, actions;
  const sent = [];
  const term = new Headless.Terminal({ cols: 80, rows: 20, scrollback: 100000, allowProposedApi: true });
  const controller = createDialogueScrollback({
    read, forward: data => sent.push(data),
    createView(callbacks) {
      actions = callbacks;
      return { term, show() { shown++; }, hide() { hidden++; }, dispose() { term.dispose(); } };
    },
  });
  t.after(() => { controller.dispose(); if (!shown) term.dispose(); });
  return { term, controller, sent, get shown() { return shown; }, get hidden() { return hidden; }, get actions() { return actions; } };
}

test('same terminal can page past 209/2000 lines to the first reply, then return to live input', async t => {
  const calls = [];
  const older = 'FIRST_DIALOGUE_REPLY\n' + Array.from({ length: 4500 }, (_, i) => 'old reply line ' + i).join('\n');
  const newer = Array.from({ length: 300 }, (_, i) => 'recent reply line ' + i).join('\n') + '\nLAST_DIALOGUE_REPLY';
  const f = fixture(t, async params => {
    calls.push(params);
    if (params.before === 1) return { available: true, messages: [{ role: 'assistant', text: older }], sourceId: 'kimi:correct-session', before: 0, hasMore: false, complete: true };
    return { available: true, messages: [{ role: 'assistant', text: newer }], sourceId: 'kimi:correct-session', before: 1, hasMore: true, complete: false };
  });
  assert.equal(f.controller.handleLiveWheel(wheel(-40)), true, 'consume wheel while read is pending, without sending it to the Agent');
  await f.controller.pending;
  assert(f.controller.visible);
  assert(visible(f.term).includes('recent reply line'));
  f.term.scrollToTop();
  f.controller.handleHistoryWheel(wheel(-40));
  await f.controller.pending;
  assert(f.term.buffer.active.baseY > 4500, 'actual terminal contains older dialogue well beyond tmux history');
  f.term.scrollToTop();
  assert(visible(f.term).includes('FIRST_DIALOGUE_REPLY'), 'first retained reply is reachable');
  assert.deepEqual(calls[1], { before: 1, sourceId: 'kimi:correct-session' });
  assert.deepEqual(f.sent, [], 'all review scrolling is presentation only');
  f.term.scrollToBottom();
  assert(visible(f.term).includes('LAST_DIALOGUE_REPLY'));
  f.controller.handleHistoryWheel(wheel(40));
  assert.equal(f.controller.visible, false);
  assert(f.hidden > 0);
  assert.deepEqual(f.sent, [], 'returning to live sends no keys or Enter');
});

test('typing exits history and forwards only the explicit new input once', async t => {
  const f = fixture(t, async () => ({ available: true, sourceId: 'kimi:s', before: 0, hasMore: false, messages: [{ role: 'user', text: 'previous prompt' }, { role: 'assistant', text: 'previous answer\x1b[6n\x1b]52;c;c2VjcmV0\x07' }] }));
  f.controller.handleLiveWheel(wheel(-40));
  await f.controller.pending;
  assert.deepEqual(f.sent, [], 'saved terminal queries cannot generate remote protocol replies');
  f.actions.onInput(' new text');
  assert.equal(f.controller.visible, false);
  assert.deepEqual(f.sent, [' new text']);
});

test('unavailable source leaves native scrolling usable instead of retrying on every gesture', async t => {
  let reads = 0;
  const f = fixture(t, async () => { reads++; return { available: false, reason: 'unsupported' }; });
  f.controller.handleLiveWheel(wheel(-40));
  await f.controller.pending;
  assert.equal(f.controller.visible, false);
  assert.equal(f.shown, 0);
  assert.equal(f.controller.handleLiveWheel(wheel(-40)), false);
  assert.equal(reads, 1);
});

test('late read cannot reopen history after leaving or disposing', async t => {
  let finish;
  const f = fixture(t, () => new Promise(resolve => { finish = resolve; }));
  f.controller.handleLiveWheel(wheel(-40));
  f.controller.hide();
  finish({ available: true, messages: [{ role: 'assistant', text: 'late answer' }], sourceId: 'kimi:s', before: 0, hasMore: false });
  await f.controller.pending;
  assert.equal(f.shown, 0);
  assert.equal(f.controller.visible, false);
});

test('dialogue text strips terminal control sequences but preserves multiline Unicode and code', () => {
  assert.equal(safeText('中文\nconst a = 1;\x1b[31m\x1b[6n\x1b]52;c;bad\x07\x00\r\n结束'), '中文\r\nconst a = 1;\r\n结束');
});
