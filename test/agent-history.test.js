import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { b64encode } from '../host/util.js';
import { loadAgentHistory } from '../host/agent-history.js';

const py = fs.readFileSync(new URL('../host/agent-history.py', import.meta.url), 'utf8');
const fragments = ['VISIBLE_REPLY_TOKEN_unique_long_line_A', 'VISIBLE_INPUT_TOKEN_unique_long_line_B', 'VISIBLE_REPLY_TOKEN_unique_long_line_C'];
const reply = fragments.join('\n');
async function run(home, request) {
  const code = `import base64,os;ns={'__name__':'fixture'};exec(compile(base64.b64decode(${JSON.stringify(b64encode(py))}),'agent-history.py','exec'),ns);os.path.expanduser=lambda p: ${JSON.stringify(home)};ns['main']()`;
  return new Promise((resolve, reject) => {
    const child = execFile('python3', ['-c', code], { timeout: 5000, maxBuffer: 2 * 1024 * 1024 }, (error, stdout) => {
      if (error) return reject(error);
      try { resolve(JSON.parse(stdout)); } catch (error) { reject(error); }
    });
    child.stdin.end(JSON.stringify(request));
  });
}
function fixture(t, rows) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-native-history-test-'));
  const root = path.join(home, '.kimi-code', 'sessions');
  fs.mkdirSync(root, { recursive: true });
  const index = [];
  for (const row of rows) {
    const dir = path.join(root, row.id);
    fs.mkdirSync(path.join(dir, 'agents', 'main'), { recursive: true });
    const records = row.messages.map(m => ({ type: 'agent.message.appended', message: { message: { role: m.role, content: [{ type: 'text', text: m.text }, { type: 'think', text: 'DO_NOT_EXPORT_REASONING' }] }, meta: { source: m.role === 'user' ? 'input' : 'llm' } } }));
    records.push({ type: 'context.append_message', message: { role: 'user', content: [{ type: 'text', text: 'DO_NOT_EXPORT_CONTEXT' }] } });
    records.push({ type: 'agent.message.appended', message: { message: { role: 'tool', content: [{ type: 'text', text: 'DO_NOT_EXPORT_TOOL_RESULT' }] }, meta: { source: 'llm' } } });
    fs.writeFileSync(path.join(dir, 'agents', 'main', 'wire.jsonl'), records.map(r => JSON.stringify(r)).join('\n') + '\n');
    const entry = JSON.stringify({ sessionId: row.id, sessionDir: dir, workDir: row.cwd });
    index.push(entry, entry); // Appended index revisions must not create ambiguity.
  }
  fs.writeFileSync(path.join(home, '.kimi-code', 'session_index.jsonl'), index.join('\n') + '\n');
  const tmux = path.join(home, 'tmux');
  fs.writeFileSync(tmux, '#!/bin/sh\nprintf "%s\\n" ' + fragments.map(s => `'${s}'`).join(' ') + '\n');
  fs.chmodSync(tmux, 0o755);
  t.after(() => {
    const target = path.resolve(home);
    assert.equal(path.dirname(target), path.resolve(os.tmpdir()));
    assert(path.basename(target).startsWith('dsh-native-history-test-'));
    fs.rmSync(target, { recursive: true, force: true });
  });
  return { home, tmux };
}
const request = f => ({ cwd: '/work', tmuxPath: f.tmux, remoteName: 'dsh-owned-test' });

test('binds the actual pane to a unique workspace dialogue and exports only user/assistant text', async t => {
  const messages = [{ role: 'user', text: 'actual prompt' }, { role: 'assistant', text: reply }];
  const f = fixture(t, [{ id: 's1', cwd: '/work', messages }, { id: 's2', cwd: '/other', messages }]);
  const result = await run(f.home, request(f));
  assert(result.available);
  assert.match(result.sourceId, /^kimi:[a-f0-9]{24}$/);
  assert.equal(result.complete, true);
  assert.deepEqual(result.messages, messages);
});

test('pages all older messages in order without silently claiming a partial result complete', async t => {
  const messages = Array.from({ length: 4 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: reply + '\n' + i + '文'.repeat(30000) }));
  const f = fixture(t, [{ id: 's1', cwd: '/work', messages }]);
  let page = await run(f.home, request(f));
  assert(page.available && page.hasMore && !page.complete);
  let recovered = page.messages;
  for (let round = 0; page.hasMore && round < 5; round++) {
    const prior = page;
    page = await run(f.home, { ...request(f), sourceId: page.sourceId, before: page.before });
    assert.equal(page.sourceId, prior.sourceId);
    assert(page.before < prior.before);
    recovered = [...page.messages, ...recovered];
  }
  assert.equal(page.before, 0);
  assert.equal(page.complete, true);
  assert.equal(page.hasMore, false);
  assert.deepEqual(recovered, messages);
});

test('ambiguous pane text never picks another conversation by recency', async t => {
  const messages = [{ role: 'assistant', text: reply }];
  const f = fixture(t, [{ id: 's1', cwd: '/work', messages }, { id: 's2', cwd: '/work', messages }]);
  const result = await run(f.home, request(f));
  assert.equal(result.available, false);
  assert.match(result.reason, /ambiguous/);
});

test('transport failures or truncated SSH output cannot masquerade as complete history', async () => {
  for (const response of [{ ok: false, stdout: '{"available":true}' }, { ok: true, truncated: true, stdout: '{"available":true}' }]) {
    const result = await loadAgentHistory({ pool: { exec: async () => response }, host: { id: 'h' }, session: { cwd: '/work', tmuxPath: '/usr/bin/tmux', remoteName: 'dsh-test' } });
    assert.equal(result.available, false);
    assert.equal(result.complete, false);
  }
});

test('JS loader uses bounded read-only SSH and passes paging data via stdin', async () => {
  let received;
  const result = await loadAgentHistory({ pool: { exec: async (_host, command, options) => { received = { command, options }; return { ok: true, stdout: JSON.stringify({ ok: true, available: false, reason: 'unsupported' }) }; } }, host: { id: 'h' }, session: { cwd: '/work', tmuxPath: '/usr/bin/tmux', remoteName: 'dsh-test' } });
  assert.equal(result.available, false);
  assert.equal(received.options.timeoutMs, 12000);
  assert.equal(received.options.maxBytes, 2 * 1024 * 1024);
  assert.equal(JSON.parse(received.options.input).cwd, '/work');
  assert.match(received.command, /^python3 -c /);
});
