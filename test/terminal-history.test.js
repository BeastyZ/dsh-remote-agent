import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { TerminalHub } from '../host/terminal.js'
import { renderSavedHistory } from '../host/terminal-history.js'

function fixture(t, tmux = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-agent-history-test-'))
  t.after(() => {
    const resolved = path.resolve(dir)
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()))
    assert(path.basename(resolved).startsWith('dsh-agent-history-test-'))
    fs.rmSync(resolved, { recursive: true, force: true })
  })
  const handles = []
  const commands = []
  const host = { id: 'test-host' }
  let alive = true
  const pool = {
    ensure: async () => ({ ok: true }),
    resolveHost: () => host,
    ptyArgv: async (_host, command) => ['ssh', command],
    ptyEnv: () => ({}),
    exec: async (_host, command) => {
      commands.push(command)
      if (command.includes('command -v tmux')) return { ok: true, stdout: tmux ? '/usr/bin/tmux\n' : '' }
      if (command.includes('kill-session')) { alive = false; return { ok: true } }
      if (command.includes('has-session')) return { ok: alive, exitCode: alive ? 0 : 1 }
      if (command.includes('new-session')) alive = true
      return { ok: true, stdout: '' }
    },
  }
  const ctx = { subprocess: { spawnTerminal: async spec => {
    let finish
    const handle = {
      output: new PassThrough(), spec,
      done: new Promise(resolve => { finish = resolve }),
      write: async () => {}, resize: async () => {},
      terminate: async () => { handle.output.end(); finish({ exitCode: 0 }) },
      exit: code => { handle.output.end(); finish({ exitCode: code }) },
    }
    handles.push(handle)
    return handle
  } } }
  const hub = () => new TerminalHub(ctx, pool, { archiveDir: dir })
  return { dir, hub, host, handles, commands, pool }
}

test('host restart retains ids, names, output and dimensions; deletion stays deleted', async t => {
  const f = fixture(t)
  const a = f.hub()
  const created = await a.create({ host: f.host, cwd: '/work', title: '研究会话', cols: 96, rows: 30 })
  assert(created.ok)
  const id = created.session.id
  f.handles[0].output.write('hello 中文\r\n')
  a.rename(id, '用户命名')
  await a.resize(id, 92, 28)
  await a.dispose()
  const b = f.hub()
  assert.equal(b.list().length, 1)
  assert.equal(b.list()[0].id, id)
  assert.equal(b.list()[0].title, '用户命名')
  assert.equal(b.list()[0].state, 'saved');
  assert.equal(b.list()[0].cols, 92)
  assert.equal((await b.read(id, 0, 0)).data, 'hello 中文\r\n')
  assert.equal((await b.resume(id, f.host)).code, 'RESTART_REQUIRED')
  const resume = await b.resume(id, f.host, { restart: true })
  assert(resume.ok)
  assert.equal(resume.session.id, id)
  assert.equal(resume.session.title, '用户命名')
  assert((await b.read(id, 0, 0)).data.startsWith('hello 中文'))
  assert.equal(resume.session.generation, 1)
  assert((await b.close(id)).ok)
  assert.equal(f.hub().list().length, 0)
})

test('exited histories are never evicted when more than 12 sessions are created', async t => {
  const f = fixture(t)
  const a = f.hub()
  for (let i = 0; i < 15; i++) {
    const result = await a.create({ host: f.host, cwd: '/work', title: `history ${i}` })
    assert(result.ok)
    f.handles.at(-1).exit(0)
    await Promise.resolve()
  }
  assert.equal(a.list().length, 15)
  await a.dispose()
  assert.equal(f.hub().list().length, 15)
})

test('ungraceful restart recovers immediate metadata checkpoint', async t => {
  const f = fixture(t)
  const a = f.hub()
  const created = await a.create({ host: f.host, cwd: '/work' })
  const b = f.hub() // no a.dispose(): simulate reading after a hard process exit
  assert.equal(b.list()[0].id, created.session.id)
  assert.equal(b.list()[0].state, 'saved')
  await a.dispose()
})

test('tmux reconnect uses the original remote session without relaunching command', async t => {
  const f = fixture(t, true)
  const a = f.hub()
  const created = await a.create({ host: f.host, cwd: '/work', command: 'kimi', title: 'Kimi' })
  assert(created.session.persistent)
  assert(f.handles[0].spec.argv[1].includes('attach-session'))
  await a.dispose()
  const b = f.hub()
  assert.equal(b.list()[0].state, 'detached')
  const count = f.commands.filter(c => c.includes('new-session')).length
  const resumed = await b.resume(created.session.id, f.host)
  assert(resumed.ok)
  assert.equal(f.commands.filter(c => c.includes('new-session')).length, count)
  assert.equal(resumed.session.id, created.session.id)
  assert((await b.close(created.session.id)).ok)
  assert(f.commands.some(c => c.includes('kill-session')))
  assert.equal(f.hub().list().length, 0)
})

test('missing remote process or failed delete never discards archived history', async t => {
  const f = fixture(t, true)
  const a = f.hub()
  const created = await a.create({ host: f.host, cwd: '/work' })
  await a.dispose()
  const b = f.hub()
  f.pool.exec = async () => ({ ok: false, code: 'AUTH', exitCode: 255 })
  assert.equal((await b.resume(created.session.id, f.host)).code, 'AUTH')
  assert.equal((await b.close(created.session.id)).ok, false)
  assert.equal(f.hub().list().length, 1)
})

test('legacy migration runs once and cannot resurrect a deleted session', async t => {
  const f = fixture(t)
  const migrationFile = path.join(f.dir, 'legacy-seed.json')
  const id = 't-123456abcdef'
  fs.writeFileSync(migrationFile, JSON.stringify({ id: 'test-migration', records: [{
    id, hostId: f.host.id, title: 'legacy session', cwd: '/work', buffer: 'saved legacy reply', total: 18,
  }] }))
  const a = new TerminalHub({}, f.pool, { archiveDir: f.dir, migrationFile })
  assert.equal(a.list().length, 1)
  assert.equal((await a.read(id, 0, 0)).data, 'saved legacy reply\r\n')
  assert((await a.close(id)).ok)
  const b = new TerminalHub({}, f.pool, { archiveDir: f.dir, migrationFile })
  assert.equal(b.list().length, 0)
})

test('concurrent reconnect and delete cannot leave a resurrected session', async t => {
  const f = fixture(t, true)
  const a = f.hub()
  const created = await a.create({ host: f.host, cwd: '/work' })
  await a.dispose()
  const b = f.hub()
  await Promise.all([b.resume(created.session.id, f.host), b.close(created.session.id)])
  assert.equal(b.list().length, 0)
  assert.equal(f.hub().list().length, 0)
})

test('tmux identity is durable while remote creation is still in flight', async t => {
  const f = fixture(t, true)
  const originalExec = f.pool.exec
  let recovered
  f.pool.exec = async (host, command) => {
    const result = await originalExec(host, command)
    if (command.includes('new-session')) {
      // The server created the process, but its response has not reached the
      // original Host yet. A replacement Host must already know the identity.
      recovered = f.hub()
      assert.equal(recovered.list().length, 1)
      assert.equal(recovered.list()[0].persistent, true)
      assert.equal(recovered.list()[0].state, 'detached')
    }
    return result
  }
  const a = f.hub()
  const created = await a.create({ host: f.host, cwd: '/work' })
  assert(created.ok)
  await a.dispose()
  const starts = f.commands.filter(c => c.includes('new-session')).length
  assert((await recovered.resume(created.session.id, f.host)).ok)
  assert.equal(f.commands.filter(c => c.includes('new-session')).length, starts)
  await recovered.close(created.session.id)
})

test('saved history retains visible tmux output after leaving alternate screen', async () => {
  const raw = '\x1b[?1049h\x1b[2J\x1b[H保留这条模型回复\r\nsecond line\x1b[?1049l'
  const text = await renderSavedHistory(raw, 80, 24)
  assert(text.includes('保留这条模型回复'))
  assert(text.includes('second line'))
  assert(!text.includes('\x1b['), 'saved view contains text rather than replayed screen switches')
})

test('saved history uses current alternate screen while an agent is still in it', async () => {
  const raw = '\x1b[?1049h\x1b[H旧内容\x1b[?1049l\x1b[?1049h\x1b[2J\x1b[H最新回复'
  const text = await renderSavedHistory(raw, 80, 24)
  assert(text.includes('最新回复'))
  assert(!text.includes('旧内容'))
})

test('archives use private files and ignore a damaged neighbor', async t => {
  const f = fixture(t)
  const a = f.hub()
  const result = await a.create({ host: f.host, cwd: '/work' })
  const file = path.join(f.dir, `${result.session.id}.json`)
  assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  fs.writeFileSync(path.join(f.dir, 't-000000000000.json'), '{corrupt')
  assert.equal(f.hub().list().length, 1)
  await a.dispose()
})
