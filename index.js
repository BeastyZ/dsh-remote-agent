// dsh-remote-agent — Host half.
//
// One workbench for remote Linux development:
//   • connections come from the local ~/.ssh/config (auto-discovered) or a
//     manually saved host; the system OpenSSH client owns auth and multiplexing,
//   • any remote directory can be saved as a workspace,
//   • the browser can list/read/write/rename/copy/delete remote files,
//   • installed agent harnesses (Codex, Kimi, Claude, …) are discovered over SSH
//     and launched in a real remote PTY,
//   • the whole surface is a small same-origin JSON RPC under
//     /remote-agent/api/rpc consumed by client.js.
//
// No remote agent is installed on the server: everything rides the existing sshd.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { parseSshConfig } from './host/sshconfig.js'
import { Store } from './host/state.js'
import { SshPool } from './host/ssh.js'
import { TerminalHub } from './host/terminal.js'
import { loadAgentHistory } from './host/agent-history.js'
import { detectHarnesses } from './host/harness.js'
import { AgentCompletionTracker } from './host/agent-completion.js'
import { LocalNotifier } from './host/notifications.js'
import * as files from './host/files.js'
import * as git from './host/git.js'
import { ForwardManager } from './host/forwards.js'
import { expandHome, hashKey, shortText, workspaceName } from './host/util.js'

export const name = 'dsh-remote-agent'
export const inject = ['webServer', 'subprocess']

const RPC_PATH = '/remote-agent/api/rpc'
const VERSION = '1.1.0'

function stateRoot() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(home, 'remote-agent')
}

function json(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

function readBody(req, limit = 48 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(Object.assign(new Error('Request body is too large.'), { code: 'TOO_LARGE' }))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
    req.on('aborted', () => reject(new Error('Client aborted the request.')))
  })
}

function cleanText(value, max = 4096) {
  return String(value ?? '').slice(0, max)
}

export function apply(ctx) {
  const dir = stateRoot()
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const store = new Store(dir)

  const askpass = path.join(dir, 'askpass.sh')
  try {
    fs.writeFileSync(askpass, '#!/bin/sh\nprintf "%s\\n" "$DSH_REMOTE_AGENT_PASSWORD"\n', { mode: 0o700 })
    fs.chmodSync(askpass, 0o700)
  } catch { /* password auth will report an actionable failure */ }

  let hostCache = null
  const hostById = new Map()

  function manualToHost(record) {
    return {
      id: record.id,
      source: 'manual',
      name: record.name || record.hostName,
      alias: record.name || record.hostName,
      hostName: record.hostName,
      user: record.user || '',
      port: Number(record.port) || 22,
      identityFile: record.identityFile ? expandHome(record.identityFile) : '',
      proxyJump: record.proxyJump || '',
      detail: `${record.user ? record.user + '@' : ''}${record.hostName}:${Number(record.port) || 22}`,
    }
  }

  function loadHosts(force = false) {
    if (hostCache && !force) return hostCache
    const state = store.get()
    const parsed = parseSshConfig(state.settings.sshConfigPath)
    const hosts = parsed.hosts.map((h) => ({ ...h }))
    for (const record of state.manualHosts) {
      const h = manualToHost(record)
      const index = hosts.findIndex((x) => x.name === h.name && x.source === 'ssh-config')
      if (index >= 0) hosts[index] = h
      else hosts.push(h)
    }
    hosts.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
    hostById.clear()
    for (const h of hosts) hostById.set(h.id, h)
    hostCache = { hosts, warnings: parsed.warnings, configPath: parsed.configPath, at: Date.now() }
    return hostCache
  }

  function resolveHost(id) {
    if (!id) return undefined
    loadHosts()
    return hostById.get(id)
  }

  const pool = new SshPool(ctx, store, { stateDir: dir, resolveHost, askpassPath: askpass })
  const terminals = new TerminalHub(ctx, pool, {
    archiveDir: path.join(dir, 'terminals'),
    workspaces: () => store.get().workspaces,
    migrationFile: new URL('./.legacy-terminals.json', import.meta.url),
  })
  const forwards = new ForwardManager(ctx, pool)
  const historySources = new Map()
  const notifications = new LocalNotifier()
  const completion = new AgentCompletionTracker({
    sessions: () => store.settings().notificationsEnabled ? terminals.observableSessions() : [],
    onComplete: async ({ session, reason, exitCode }) => {
      const workspace = store.get().workspaces.find(item => item.id === session.workspaceId)
      const body = reason === 'idle'
        ? `${session.title} 已完成一轮任务${workspace ? ` · ${workspace.name}` : ''}`
        : `${session.title} 已退出${exitCode == null ? '' : ` · 退出码 ${exitCode}`}`
      try { await notifications.send({ title: '远程 Agent 已完成', body }) }
      catch (error) { ctx.logger.warn('Local completion notification failed', error.message) }
    },
  })

  function ok(value) {
    return { ok: true, value }
  }

  function fail(code, message) {
    return { ok: false, error: { code: code || 'ERROR', message: message || 'Operation failed.' } }
  }

  function fromResult(result, fallback) {
    if (result && result.ok === false) return fail(result.code, result.message || fallback)
    return ok(result)
  }

  function requireHost(params) {
    const host = resolveHost(params?.hostId)
    if (!host) throw Object.assign(new Error('Unknown connection. Refresh the connection list.'), { code: 'NO_HOST' })
    return host
  }

  function requirePath(params) {
    const p = String(params?.path || '').trim()
    if (!p) throw Object.assign(new Error('A remote path is required.'), { code: 'INVALID' })
    return p
  }

  function workspaceView(ws) {
    const host = resolveHost(ws.hostId)
    return {
      ...ws,
      hostName: host?.name || ws.hostId,
      online: Boolean(host),
    }
  }

  function addWorkspace(host, remotePath) {
    const resolved = remotePath === '~' ? '~' : remotePath.replace(/\/+$/, '') || '/'
    const id = 'w-' + hashKey(`${host.id}:${resolved}`)
    const existing = store.get().workspaces.find((w) => w.id === id)
    const ws = store.addWorkspace({
      id,
      hostId: host.id,
      path: resolved,
      name: workspaceName(resolved),
      createdAt: existing?.createdAt || Date.now(),
      lastUsedAt: Date.now(),
    })
    store.setSelection(host.id, id)
    return workspaceView(ws)
  }

  const methods = {
    async bootstrap() {
      const hosts = loadHosts(true).hosts
      const state = store.get()
      const available = new Set(hosts.map((h) => h.id))
      const workspaces = state.workspaces.filter((w) => available.has(w.hostId)).map(workspaceView)
      return ok({
        version: VERSION,
        hosts,
        configPath: loadHosts().configPath,
        warnings: loadHosts().warnings,
        workspaces,
        lastHostId: available.has(state.lastHostId) ? state.lastHostId : (hosts[0]?.id || null),
        lastWorkspaceId: workspaces.some((w) => w.id === state.lastWorkspaceId) ? state.lastWorkspaceId : null,
        settings: {
          sshConfigPath: state.settings.sshConfigPath || loadHosts().configPath,
          strictHostKeyChecking: state.settings.strictHostKeyChecking,
          stateDir: dir,
          notificationsEnabled: state.settings.notificationsEnabled,
          notificationPlatform: notifications.capability(),
        },
        activeTerminals: state.activeTerminals || {},
        terminals: terminals.list(),
      })
    },

    async 'hosts.refresh'(params) {
      const hosts = loadHosts(true).hosts
      if (params?.probe) {
        for (const host of hosts) {
          const r = await pool.ensure(host)
          host.status = r.ok ? 'online' : 'offline'
          host.latencyMs = r.latencyMs || 0
          if (!r.ok) host.error = r.message
        }
      }
      return ok({ hosts })
    },

    async 'host.test'(params) {
      const host = requireHost(params)
      const r = await pool.ensure(host, { force: Boolean(params?.force) })
      if (!r.ok) return fail(r.code, r.message)
      return ok({ ok: true, latencyMs: r.latencyMs, reused: r.reused, host: { id: host.id, detail: host.detail } })
    },

    async 'host.password'(params) {
      const host = requireHost(params)
      const password = String(params?.password || '')
      if (!password) return fail('INVALID', 'A password is required.')
      pool.setPassword(host.id, password)
      const r = await pool.ensure(host, { force: true })
      if (!r.ok) {
        pool.setPassword(host.id, '')
        return fail(r.code, r.message)
      }
      return ok({ ok: true, latencyMs: r.latencyMs })
    },

    async 'host.disconnect'(params) {
      const host = requireHost(params)
      await forwards.dropHost(host.id)
      await pool.disconnect(host)
      return ok({ ok: true })
    },

    async 'hosts.addManual'(params) {
      const record = params?.host || {}
      const hostName = cleanText(record.hostName, 255).trim()
      if (!hostName) return fail('INVALID', 'Host name is required.')
      const name = cleanText(record.name, 80).trim() || hostName
      const id = record.id || 'm-' + randomBytes(5).toString('hex')
      store.addManualHost({
        id,
        name,
        hostName,
        user: cleanText(record.user, 80).trim(),
        port: Math.max(1, Math.min(Number(record.port) || 22, 65535)),
        identityFile: cleanText(record.identityFile, 1024).trim(),
        proxyJump: cleanText(record.proxyJump, 512).trim(),
      })
      loadHosts(true)
      return ok({ host: resolveHost(id) })
    },

    async 'hosts.removeManual'(params) {
      const id = String(params?.id || '')
      const host = resolveHost(id)
      if (!host) return fail('NO_HOST', 'Unknown connection.')
      if (host.source !== 'manual') return fail('INVALID', 'Hosts imported from ~/.ssh/config are removed by editing the file.')
      await pool.disconnect(host)
      store.removeManualHost(id)
      loadHosts(true)
      return ok({ ok: true })
    },

    async 'fs.home'(params) {
      const host = requireHost(params)
      return fromResult(await files.home(pool, host))
    },

    async 'fs.resolve'(params) {
      const host = requireHost(params)
      return fromResult(await files.resolvePath(pool, host, requirePath(params)))
    },

    async 'fs.list'(params) {
      const host = requireHost(params)
      return fromResult(await files.listDir(pool, host, requirePath(params)))
    },

    async 'fs.stat'(params) {
      const host = requireHost(params)
      return fromResult(await files.statPath(pool, host, requirePath(params)))
    },

    async 'fs.read'(params) {
      const host = requireHost(params)
      return fromResult(await files.readFile(pool, host, requirePath(params), { maxBytes: params?.maxBytes }))
    },

    async 'fs.write'(params) {
      const host = requireHost(params)
      const base64 = String(params?.base64 || '')
      if (base64.length > 40 * 1024 * 1024) return fail('TOO_LARGE', 'File is too large to save through this panel.')
      return fromResult(await files.writeFile(pool, host, requirePath(params), base64, {
        expectedMtime: params?.expectedMtime ?? null,
        mode: params?.mode || '',
      }))
    },

    async 'fs.mkdir'(params) {
      const host = requireHost(params)
      return fromResult(await files.mkdir(pool, host, requirePath(params)))
    },

    async 'fs.remove'(params) {
      const host = requireHost(params)
      return fromResult(await files.remove(pool, host, requirePath(params)))
    },

    async 'fs.rename'(params) {
      const host = requireHost(params)
      const from = String(params?.from || params?.path || '').trim()
      const to = String(params?.to || '').trim()
      if (!from) return fail('INVALID', 'A source path is required.')
      if (!to) return fail('INVALID', 'A destination is required.')
      return fromResult(await files.rename(pool, host, from, to))
    },

    async 'fs.transfer'(params) {
      const host = requireHost(params)
      const dest = String(params?.destDir || '').trim()
      if (!dest) return fail('INVALID', 'A destination directory is required.')
      return fromResult(await files.transfer(pool, host, params?.sources, dest, { move: Boolean(params?.move) }))
    },

    async 'fs.search'(params) {
      const host = requireHost(params)
      return fromResult(await files.searchFiles(pool, host, requirePath(params), params?.query, { limit: params?.limit }))
    },

    async 'ws.add'(params) {
      const host = requireHost(params)
      const target = requirePath(params)
      const resolved = await files.resolvePath(pool, host, target)
      if (!resolved.ok) return fail(resolved.code, resolved.message)
      const ws = addWorkspace(host, resolved.path)
      return ok({ workspace: ws })
    },

    async 'ws.remove'(params) {
      const id = String(params?.id || '')
      const ws = store.get().workspaces.find((w) => w.id === id)
      if (!ws) return fail('NO_WORKSPACE', 'Workspace not found.')
      store.removeWorkspace(id)
      return ok({ ok: true })
    },

    async 'ws.select'(params) {
      store.setSelection(params?.hostId, params?.workspaceId)
      const workspace = store.get().workspaces.find(ws => ws.id === params?.workspaceId)
      return ok({ ok: true, activeTerminalId: workspace ? store.activeTerminal(workspace.id) : null })
    },

    async 'ws.selectTerminal'(params) {
      const workspace = store.get().workspaces.find(item => item.id === String(params?.workspaceId || ''))
      if (!workspace) return fail('NO_WORKSPACE', 'Workspace not found.')
      store.setActiveTerminal(workspace.id, String(params?.terminalId || ''))
      return ok({ ok: true })
    },

    async 'harness.list'(params) {
      const host = requireHost(params)
      const ttl = Number(store.settings().harnessCacheTtlMs) || 600000
      const cached = store.harnessCache(host.id)
      if (!params?.force && cached && Date.now() - cached.at < ttl) {
        return ok({
          harnesses: cached.list,
          tools: cached.tools || {},
          env: cached.env || null,
          at: cached.at,
          cached: true,
        })
      }
      const result = await detectHarnesses(pool, host)
      if (!result.ok) return fail(result.code, result.message)
      store.setHarnessCache(host.id, result.harnesses, { tools: result.tools, env: result.env })
      return ok({ ...result, cached: false })
    },

    async 'term.list'() {
      return ok({ terminals: terminals.list() })
    },

    async 'term.create'(params) {
      const host = requireHost(params)
      const cwd = String(params?.cwd || '').trim()
      if (!cwd) return fail('INVALID', 'A workspace directory is required.')
      const result = await terminals.create({
        host,
        cwd,
        workspaceId: String(params?.workspaceId || ''),
        command: String(params?.command || ''),
        title: cleanText(params?.title, 120) || 'terminal',
        cols: Number(params?.cols) || 100,
        rows: Number(params?.rows) || 26,
      })
      return fromResult(result)
    },

    async 'term.resume'(params) {
      const id = String(params?.id || '')
      const session = terminals.get(id)
      if (!session) return fail('NO_SESSION', 'Terminal not found.')
      return fromResult(await terminals.resume(id, resolveHost(session.hostId), { restart: params?.restart === true }))
    },

    async 'term.history'(params) {
      const session = terminals.get(String(params?.id || ''))
      if (!session) return fail('NO_SESSION', 'Terminal not found.')
      const host = resolveHost(session.hostId)
      if (!host) return fail('NO_HOST', 'Original SSH connection not found.')
      const key = session.id + ':' + session.generation
      if (params?.sourceId && historySources.get(key) !== params.sourceId) return fail('HISTORY_SOURCE', 'Reload dialogue history before paging.')
      const result = await loadAgentHistory({
        pool, host, session, before: params?.before, sourceId: params?.sourceId,
      })
      if (result.available && result.sourceId) {
        historySources.set(key, result.sourceId)
        if (!params?.sourceId) {
          const reset = await terminals.resetScroll(session.id)
          if (!reset.ok) return fromResult(reset)
        }
      }
      return fromResult(result)
    },

    async 'term.read'(params) {
      return fromResult(await terminals.read(String(params?.id || ''), Number(params?.offset) || 0, Number(params?.waitMs) || 0))
    },

    async 'term.write'(params) {
      const id = String(params?.id || '')
      const data = String(params?.data ?? '')
      if (data.length > 64 * 1024) return fail('TOO_LARGE', 'Keystroke payload is too large.')
      return fromResult(await terminals.write(id, data))
    },

    async 'term.resize'(params) {
      return fromResult(await terminals.resize(String(params?.id || ''), Number(params?.cols) || 80, Number(params?.rows) || 24))
    },

    async 'term.rename'(params) {
      const id = String(params?.id || '')
      const title = cleanText(params?.title, 120).trim()
      if (!title) return fail('INVALID', 'A session title is required.')
      return fromResult(await terminals.rename(id, title))
    },

    async 'term.close'(params) {
      return fromResult(await terminals.close(String(params?.id || '')))
    },

    async 'git.info'(params) {
      const host = requireHost(params)
      const path = requirePath(params)
      return fromResult(await git.info(pool, host, path))
    },

    async 'git.diff'(params) {
      const host = requireHost(params)
      const path = requirePath(params)
      return fromResult(await git.diff(pool, host, path, {
        path: String(params?.file || '').trim(),
        staged: Boolean(params?.staged),
        untracked: Boolean(params?.untracked),
      }))
    },

    async 'git.stage'(params) {
      const host = requireHost(params)
      const path = requirePath(params)
      return fromResult(await git.stage(pool, host, path, params?.files || []))
    },

    async 'git.unstage'(params) {
      const host = requireHost(params)
      const path = requirePath(params)
      return fromResult(await git.unstage(pool, host, path, params?.files || []))
    },

    async 'git.commit'(params) {
      const host = requireHost(params)
      const path = requirePath(params)
      return fromResult(await git.commit(pool, host, path, params?.message, { all: Boolean(params?.all) }))
    },

    async 'git.worktrees'(params) {
      const host = requireHost(params)
      const path = requirePath(params)
      return fromResult(await git.worktreeList(pool, host, path))
    },

    async 'git.worktreeAdd'(params) {
      const host = requireHost(params)
      const path = requirePath(params)
      const result = await git.worktreeAdd(pool, host, path, {
        branch: String(params?.branch || '').trim(),
        base: String(params?.base || 'HEAD').trim(),
        existing: Boolean(params?.existing),
      })
      if (!result.ok) return fail(result.code, result.message)
      const workspace = addWorkspace(host, result.path)
      return ok({ ...result, workspace })
    },

    async 'git.worktreeRemove'(params) {
      const host = requireHost(params)
      const path = requirePath(params)
      const target = String(params?.worktree || '').trim()
      if (!target) return fail('INVALID', 'A worktree path is required.')
      const result = await git.worktreeRemove(pool, host, path, target)
      if (!result.ok) return fail(result.code, result.message)
      const existing = store.get().workspaces.find((ws) => ws.hostId === host.id && ws.path === target)
      if (existing) store.removeWorkspace(existing.id)
      return ok({ ...result, removedWorkspaceId: existing?.id || null })
    },

    async 'forward.list'(params) {
      const hostId = params?.hostId ? String(params.hostId) : ''
      return ok({ forwards: forwards.list(hostId) })
    },

    async 'forward.add'(params) {
      const host = requireHost(params)
      return fromResult(await forwards.add(host, {
        localPort: params?.localPort,
        remotePort: params?.remotePort,
        remoteHost: params?.remoteHost || 'localhost',
      }))
    },

    async 'forward.remove'(params) {
      return fromResult(await forwards.remove(String(params?.id || '')))
    },

    async 'session.rename'(params) {
      const sessionId = String(params?.sessionId || '').trim()
      const title = cleanText(params?.title, 200).trim()
      if (!sessionId) return fail('INVALID', 'A session id is required.')
      if (!title) return fail('INVALID', 'A session title is required.')
      const sessions = ctx.get('sessions')
      const titles = ctx.get('sessionTitle')
      if (!sessions || typeof sessions.get !== 'function') return fail('UNSUPPORTED', 'The session store is unavailable.')
      if (!titles || typeof titles.rename !== 'function') return fail('UNSUPPORTED', 'Session titles cannot be renamed in this build.')
      const session = sessions.get(sessionId)
      if (!session) return fail('NO_SESSION', 'The session is not live; open it and try again.')
      try {
        const snapshot = titles.rename(session, title)
        return ok({ title: snapshot?.title || title })
      } catch (err) {
        return fail('RENAME', err?.message || 'Cannot rename this session.')
      }
    },

    async 'settings.get'() {
      const settings = store.settings()
      return ok({
        ...settings,
        sshConfigPath: settings.sshConfigPath || loadHosts().configPath,
        stateDir: dir,
        configPath: loadHosts().configPath,
        notificationPlatform: notifications.capability(),
      })
    },

    async 'notification.test'() {
      if (!store.settings().notificationsEnabled) return fail('DISABLED', 'Enable agent completion notifications first.')
      try {
        await notifications.send({ title: 'Remote agent', body: '这是来自远程 Agent 工作台的 macOS 测试通知。' })
        return ok({ sent: true })
      } catch (error) { return fail('NOTIFICATION', error.message) }
    },

    async 'settings.set'(params) {
      const next = params?.settings && typeof params.settings === 'object' ? params.settings : {}
      const settings = store.settings()
      if (typeof next.sshConfigPath === 'string') settings.sshConfigPath = expandHome(next.sshConfigPath.trim())
      if (typeof next.strictHostKeyChecking === 'string' && ['yes', 'accept-new', 'no'].includes(next.strictHostKeyChecking)) {
        settings.strictHostKeyChecking = next.strictHostKeyChecking
      }
      if (Number(next.controlPersistSeconds) > 0) settings.controlPersistSeconds = Math.floor(Number(next.controlPersistSeconds))
      if (Number(next.harnessCacheTtlMs) > 0) settings.harnessCacheTtlMs = Math.floor(Number(next.harnessCacheTtlMs))
      if (typeof next.notificationsEnabled === 'boolean') settings.notificationsEnabled = next.notificationsEnabled
      store.save()
      loadHosts(true)
      return ok({ settings })
    },
  }

  async function dispatch(method, params) {
    try {
      const fn = Object.prototype.hasOwnProperty.call(methods, method) ? methods[method] : undefined
      if (!fn) return fail('NO_METHOD', `Unknown method: ${shortText(method, 80)}`)
      return await fn(params || {})
    } catch (err) {
      const code = err?.code || 'INTERNAL'
      const message = err?.message || String(err)
      return fail(code, message)
    }
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/remote-agent/api',
    handler: async (req, res) => {
      try {
        const url = new URL(req.url || '/', 'http://localhost')
        if (url.pathname !== RPC_PATH && url.pathname !== RPC_PATH + '/') {
          return json(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: 'Not found.' } })
        }
        if (req.method !== 'POST') {
          res.setHeader('allow', 'POST')
          return json(res, 405, { ok: false, error: { code: 'METHOD', message: 'Use POST.' } })
        }
        const origin = req.headers.origin
        if (origin) {
          let allowed = false
          try { allowed = new URL(origin).host === req.headers.host } catch { allowed = false }
          if (!allowed) return json(res, 403, { ok: false, error: { code: 'FORBIDDEN', message: 'Cross-origin request rejected.' } })
        }
        if (String(req.headers['x-requested-with'] || '') !== 'XMLHttpRequest') {
          return json(res, 403, { ok: false, error: { code: 'FORBIDDEN', message: 'Missing request marker.' } })
        }
        const text = await readBody(req)
        let payload
        try { payload = JSON.parse(text || '{}') } catch { return json(res, 400, { ok: false, error: { code: 'BAD_JSON', message: 'Body must be JSON.' } }) }
        const result = await dispatch(String(payload.method || ''), payload.params || {})
        return json(res, 200, result)
      } catch (err) {
        if (!res.headersSent) return json(res, 500, { ok: false, error: { code: 'INTERNAL', message: err?.message || String(err) } })
        try { res.end() } catch { /* ignore */ }
      }
    },
  }))

  // The official Electron shell does not expose the legacy Web route; it
  // authenticates and forwards plugin fetches through Connection under /api.
  ctx.inject(['connection'], (inner) => {
    const connection = inner.get('connection')
    if (!connection || typeof connection.fetch?.register !== 'function') return
    try {
      const dispose = connection.fetch.register({
        path: '/api/remote-agent/api/rpc',
        methods: ['POST'],
        requestBody: 'buffered',
        async fetch(request) {
          try {
            const text = await request.text()
            let payload
            try { payload = JSON.parse(text || '{}') } catch { return Response.json({ ok: false, error: { code: 'BAD_JSON', message: 'Body must be JSON.' } }, { status: 400 }) }
            const result = await dispatch(String(payload.method || ''), payload.params || {})
            return Response.json(result)
          } catch (err) {
            return Response.json({ ok: false, error: { code: 'INTERNAL', message: err?.message || String(err) } }, { status: 500 })
          }
        },
      })
      inner.effect(() => () => dispose(), 'remote-agent.connection-fetch')
    } catch (err) {
      console.warn('[dsh-remote-agent] connection fetch route was not registered:', err?.message || err)
    }
  })

  ctx.effect(() => () => {
    completion.dispose()
    forwards.dispose().catch(() => {})
    pool.dispose().catch(() => {})
    terminals.dispose().catch(() => {})
    store.dispose()
  })

  ctx.logger?.info?.('[dsh-remote-agent] workbench ready')
}
