// Local port forwards over the existing SSH master.
//
// A forward is added to the OpenSSH master with `-O forward -L ...` and removed
// with `-O cancel -L ...`, so it is owned by the same connection as the terminals
// and survives page reloads until the master exits or the user removes it.
// Only 127.0.0.1 is bound locally.

import net from 'node:net'
import { randomBytes } from 'node:crypto'

function validPort(value) {
  const port = Number(value)
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : null
}

function canListen(port) {
  return new Promise((resolve) => {
    const server = net.createServer()
    let settled = false
    const finish = (ok) => {
      if (settled) return
      settled = true
      server.close(() => resolve(ok))
    }
    server.once('error', () => finish(false))
    server.listen({ host: '127.0.0.1', port }, () => finish(true))
  })
}

async function allocateLocalPort(preferred, used) {
  for (let port = preferred; port < preferred + 40 && port < 65536; port++) {
    if (used.has(port)) continue
    // eslint-disable-next-line no-await-in-loop
    if (await canListen(port)) return port
  }
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen({ host: '127.0.0.1', port: 0 }, () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : null
      server.close(() => (port ? resolve(port) : reject(new Error('No free local port.'))))
    })
  })
}

export class ForwardManager {
  constructor(ctx, pool) {
    this.ctx = ctx
    this.pool = pool
    this.forwards = []
  }

  list(hostId) {
    return this.forwards
      .filter((forward) => !hostId || forward.hostId === hostId)
      .map((forward) => ({ ...forward, url: `http://127.0.0.1:${forward.localPort}` }))
  }

  get(id) {
    return this.forwards.find((forward) => forward.id === id)
  }

  async add(host, { localPort, remotePort, remoteHost = 'localhost' } = {}) {
    const wantedRemote = validPort(remotePort)
    if (!wantedRemote) return { ok: false, code: 'INVALID', message: 'A remote port is required (1-65535).' }
    const used = new Set(this.forwards.filter((forward) => forward.hostId === host.id).map((forward) => forward.localPort))
    let preferred = validPort(localPort) || wantedRemote
    // A same remote port on another host may already occupy the natural local port.
    let local = 0
    try {
      local = await allocateLocalPort(preferred, used)
    } catch (error) {
      return { ok: false, code: 'PORT', message: error.message || 'No free local port.' }
    }
    const targetHost = String(remoteHost || 'localhost').trim() || 'localhost'
    const spec = `127.0.0.1:${local}:${targetHost}:${wantedRemote}`
    const result = await this.pool.control(host, ['-O', 'forward', '-L', spec])
    if (!result.ok) {
      return { ok: false, code: 'FORWARD', message: result.message || 'Cannot open the local port forward.' }
    }
    const forward = {
      id: 'f-' + randomBytes(5).toString('hex'),
      hostId: host.id,
      hostName: host.name,
      localPort: local,
      remotePort: wantedRemote,
      remoteHost: targetHost,
      spec,
      createdAt: Date.now(),
      url: `http://127.0.0.1:${local}`,
    }
    this.forwards.push(forward)
    return { ok: true, forward }
  }

  async remove(id) {
    const forward = this.get(id)
    if (!forward) return { ok: true }
    const host = this.pool.resolveHost(forward.hostId)
    if (host) {
      await this.pool.control(host, ['-O', 'cancel', '-L', forward.spec]).catch(() => {})
    }
    this.forwards = this.forwards.filter((item) => item.id !== id)
    return { ok: true }
  }

  async dropHost(hostId) {
    this.forwards = this.forwards.filter((forward) => forward.hostId !== hostId)
  }

  async dispose() {
    const ids = this.forwards.map((forward) => forward.id)
    for (const id of ids) await this.remove(id)
  }
}
