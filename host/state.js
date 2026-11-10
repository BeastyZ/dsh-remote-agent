// Durable plugin state: manual connections, saved remote workspaces,
// UI selections and small preferences. Secrets are never written here.

import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'

const EMPTY = {
  version: 1,
  manualHosts: [],
  workspaces: [],
  lastHostId: null,
  lastWorkspaceId: null,
  settings: {
    sshConfigPath: '',
    strictHostKeyChecking: 'accept-new',
    controlPersistSeconds: 600,
    harnessCacheTtlMs: 10 * 60 * 1000,
  },
  harnessCache: {},
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

export class Store {
  constructor(dir) {
    this.dir = dir
    this.file = path.join(dir, 'state.json')
    this.state = clone(EMPTY)
    this._timer = null
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    this.load()
  }

  load() {
    try {
      const text = fs.readFileSync(this.file, 'utf8')
      const parsed = JSON.parse(text)
      this.state = { ...clone(EMPTY), ...parsed }
      this.state.settings = { ...EMPTY.settings, ...(parsed.settings || {}) }
      if (!Array.isArray(this.state.manualHosts)) this.state.manualHosts = []
      if (!Array.isArray(this.state.workspaces)) this.state.workspaces = []
      if (!this.state.harnessCache || typeof this.state.harnessCache !== 'object') this.state.harnessCache = {}
    } catch {
      // Missing or corrupt state starts clean rather than failing activation.
    }
  }

  save() {
    if (this._timer) return
    this._timer = setTimeout(() => {
      this._timer = null
      this.flush()
    }, 120)
    this._timer.unref?.()
  }

  flush() {
    if (this._timer) {
      clearTimeout(this._timer)
      this._timer = null
    }
    try {
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 })
      const tmp = path.join(this.dir, `.state-${randomBytes(4).toString('hex')}.tmp`)
      fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2), { mode: 0o600 })
      fs.renameSync(tmp, this.file)
    } catch {
      // Persistence is best-effort; the running session keeps working.
    }
  }

  dispose() {
    if (this._timer) this.flush()
  }

  get() {
    return this.state
  }

  settings() {
    return this.state.settings
  }

  addManualHost(host) {
    const existing = this.state.manualHosts.find((h) => h.id === host.id)
    if (existing) Object.assign(existing, host)
    else this.state.manualHosts.push(host)
    this.save()
    return host
  }

  removeManualHost(id) {
    this.state.manualHosts = this.state.manualHosts.filter((h) => h.id !== id)
    this.state.workspaces = this.state.workspaces.filter((w) => w.hostId !== id)
    if (this.state.lastHostId === id) this.state.lastHostId = null
    this.save()
  }

  addWorkspace(ws) {
    const existing = this.state.workspaces.find((w) => w.id === ws.id)
    if (existing) Object.assign(existing, ws)
    else this.state.workspaces.push(ws)
    this.save()
    return ws
  }

  removeWorkspace(id) {
    this.state.workspaces = this.state.workspaces.filter((w) => w.id !== id)
    if (this.state.lastWorkspaceId === id) this.state.lastWorkspaceId = null
    this.save()
  }

  setSelection(hostId, workspaceId) {
    if (hostId !== undefined) this.state.lastHostId = hostId
    if (workspaceId !== undefined) this.state.lastWorkspaceId = workspaceId
    this.save()
  }

  harnessCache(hostId) {
    const entry = this.state.harnessCache[hostId]
    if (!entry || !Array.isArray(entry.list)) return null
    return entry
  }

  setHarnessCache(hostId, list, extra = {}) {
    this.state.harnessCache[hostId] = { at: Date.now(), list, ...extra }
    this.save()
  }

  clearHarnessCache(hostId) {
    if (hostId) delete this.state.harnessCache[hostId]
    else this.state.harnessCache = {}
    this.save()
  }
}
