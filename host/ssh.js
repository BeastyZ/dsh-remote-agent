// SSH transport for the remote agent workbench.
//
// The plugin deliberately drives the system OpenSSH client instead of
// re-implementing SSH: ~/.ssh/config (Include, ProxyJump, ProxyCommand,
// IdentityFile, Match), ssh-agent, FIDO keys, host-key policies and ControlMaster
// multiplexing all keep working exactly as they do in a terminal.
//
// One persistent master connection per host: the first operation opens
// `ssh -M -N -f`, every later command/PTY reuses the socket. Password auth is
// supported through a tiny askpass helper; the password itself lives in this
// process's memory only.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { classifySshError, expandHome, hashKey, sleep, shortText } from './util.js'

const ENV_KEYS = [
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE',
  'SSH_AUTH_SOCK', 'SSH_AGENT_PID', 'SSH_CONFIG', 'DISPLAY', 'TERM', 'TZ',
  'SystemRoot', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'ComSpec', 'PATHEXT',
]

function pickEnv(extra) {
  const env = {}
  for (const key of ENV_KEYS) {
    if (process.env[key] !== undefined) env[key] = process.env[key]
  }
  return { ...env, ...(extra || {}) }
}

export class SshPool {
  /**
   * @param {object} ctx Cordis context (subprocess service injected)
   * @param {import('./state.js').Store} store
   * @param {{stateDir: string, resolveHost: (id: string) => object | undefined, askpassPath: string}} opts
   */
  constructor(ctx, store, opts) {
    this.ctx = ctx
    this.store = store
    this.stateDir = opts.stateDir
    this.resolveHost = opts.resolveHost
    this.askpassPath = opts.askpassPath
    this.ssh = null
    this.masters = new Map()
    this.passwords = new Map()
    this.home = os.homedir()
    this.runDir = path.join(this.stateDir, 'run')
    fs.mkdirSync(this.runDir, { recursive: true, mode: 0o700 })
    this.ready = this._init()
  }

  async _init() {
    const candidates = [
      '/usr/bin/ssh',
      '/usr/local/bin/ssh',
      '/opt/homebrew/bin/ssh',
      'C:\\Windows\\System32\\OpenSSH\\ssh.exe',
    ]
    try {
      this.ssh = await this.ctx.subprocess.resolveExecutable('ssh')
    } catch {
      this.ssh = candidates.find((p) => { try { return fs.statSync(p).isFile() } catch { return false } }) || null
    }
    if (!this.ssh) throw new Error('OpenSSH client not found. Install openssh-client (or enable the Windows OpenSSH feature).')
    return this.ssh
  }

  async _sh() {
    if (this.ssh) return this.ssh
    await this.ready
    return this.ssh
  }

  settings() {
    return this.store.settings()
  }

  persistSeconds() {
    const n = Number(this.settings().controlPersistSeconds)
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 600
  }

  strictHostKey() {
    const v = this.settings().strictHostKeyChecking
    return v === 'yes' || v === 'accept-new' || v === 'no' ? v : 'accept-new'
  }

  socketPath(host) {
    return path.join(this.runDir, `m-${hashKey(host.id || host.alias || host.hostName)}.sock`)
  }

  setPassword(hostId, password) {
    if (password) this.passwords.set(hostId, String(password))
    else this.passwords.delete(hostId)
  }

  hasPassword(hostId) {
    return this.passwords.has(hostId)
  }

  _askpassEnv(host) {
    const pw = this.passwords.get(host.id)
    if (!pw) return {}
    return {
      SSH_ASKPASS: this.askpassPath,
      SSH_ASKPASS_REQUIRE: 'force',
      DISPLAY: process.env.DISPLAY || ':0',
      DSH_REMOTE_AGENT_PASSWORD: pw,
    }
  }

  baseArgs(host) {
    const args = [
      '-o', 'ConnectTimeout=12',
      '-o', 'ServerAliveInterval=20',
      '-o', 'ServerAliveCountMax=3',
      '-o', 'LogLevel=ERROR',
      '-o', `StrictHostKeyChecking=${this.strictHostKey()}`,
      '-o', `ControlMaster=auto`,
      '-o', `ControlPath=${this.socketPath(host)}`,
      '-o', `ControlPersist=${this.persistSeconds()}`,
    ]
    return args
  }

  targetArgs(host) {
    const args = []
    if (host.source === 'ssh-config' && host.alias) {
      // Let OpenSSH resolve the alias itself (HostName/User/Port/ProxyJump and
      // any Match rules), so the connection follows the user's config exactly.
      return [host.alias]
    }
    if (host.port && Number(host.port) !== 22) args.push('-p', String(host.port))
    if (host.identityFile) {
      args.push('-o', 'IdentitiesOnly=yes', '-i', expandHome(host.identityFile))
    }
    if (host.proxyJump) args.push('-J', host.proxyJump)
    const dest = host.user ? `${host.user}@${host.hostName || host.alias}` : (host.hostName || host.alias)
    args.push(dest)
    return args
  }

  async _run(argv, { input = null, timeoutMs = 30000, maxBytes = 8 * 1024 * 1024, env = {} } = {}) {
    const ac = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; ac.abort() }, timeoutMs)
    timer.unref?.()
    let handle
    try {
      handle = this.ctx.subprocess.spawn({
        argv,
        cwd: this.home,
        stdio: {
          stdin: input == null ? 'ignore' : 'pipe',
          stdout: { maxBytes },
          stderr: { maxBytes },
        },
        graceMs: 1500,
        signal: ac.signal,
        env: pickEnv(env),
      })
    } catch (err) {
      clearTimeout(timer)
      return { ok: false, exitCode: null, stdout: '', stderr: '', error: err, code: 'SPAWN', message: err?.message || 'cannot start ssh' }
    }
    if (input != null && handle.stdin) {
      try { handle.stdin.end(input) } catch { /* provider may already have closed it */ }
    }
    let outcome = null
    let error = null
    try {
      outcome = await handle.done
    } catch (err) {
      error = err
    }
    clearTimeout(timer)
    const read = (reader) => {
      try { return reader ? reader.readFrom(0) : null } catch { return null }
    }
    const out = read(handle.collected?.stdout)
    const errOut = read(handle.collected?.stderr)
    const exitCode = outcome && typeof outcome.exitCode === 'number' ? outcome.exitCode : null
    return {
      ok: !error && exitCode === 0,
      exitCode,
      signal: outcome?.signal || null,
      stdout: out?.text || '',
      stderr: errOut?.text || '',
      truncated: Boolean(out?.lossy || errOut?.lossy),
      timedOut,
      error,
    }
  }

  async _masterAlive(host) {
    const sock = this.socketPath(host)
    try {
      if (!fs.statSync(sock).isSocket()) return false
    } catch {
      return false
    }
    const ssh = await this._sh()
    const args = [ssh, '-S', sock, '-o', 'ControlMaster=no', '-O', 'check', ...this.targetArgs(host)]
    const r = await this._run(args, { timeoutMs: 5000, maxBytes: 64 * 1024 })
    return r.ok
  }

  /** Ensure a persistent master connection. Returns transport facts, never throws. */
  async ensure(host, { force = false } = {}) {
    if (!host) return { ok: false, code: 'NO_HOST', message: 'Unknown connection.' }
    const ssh = await this._sh()
    const cached = this.masters.get(host.id)
    if (!force && cached && Date.now() - cached.at < 8000) {
      return { ok: true, reused: true, latencyMs: cached.latencyMs || 0 }
    }
    if (!force && await this._masterAlive(host)) {
      const latency = cached?.latencyMs || 0
      this.masters.set(host.id, { at: Date.now(), latencyMs: latency })
      return { ok: true, reused: true, latencyMs: latency }
    }
    if (force) {
      // An explicit reconnect closes the old master (and its multiplexed
      // sessions) before the socket is replaced.
      await this._run([ssh, '-S', this.socketPath(host), '-o', 'ControlMaster=no', '-O', 'exit', ...this.targetArgs(host)], { timeoutMs: 4000, maxBytes: 32 * 1024 }).catch(() => {})
    }
    try { fs.rmSync(this.socketPath(host), { force: true }) } catch { /* ignore */ }

    const args = [
      ssh, '-M', '-N', '-f',
      '-o', 'ControlMaster=yes',
      '-o', `ControlPath=${this.socketPath(host)}`,
      '-o', `ControlPersist=${this.persistSeconds()}`,
      // Without a stored secret, fail fast instead of waiting for a prompt the
      // child cannot answer; the UI then asks for a password/passphrase.
      ...(this.passwords.has(host.id) ? [] : ['-o', 'BatchMode=yes']),
      ...this.baseArgs(host),
      ...this.targetArgs(host),
    ]
    const started = Date.now()
    const r = await this._run(args, {
      timeoutMs: 30000,
      maxBytes: 256 * 1024,
      env: this._askpassEnv(host),
    })
    const latencyMs = Date.now() - started
    const socketReady = (() => {
      try { return fs.statSync(this.socketPath(host)).isSocket() } catch { return false }
    })()
    if (r.ok && socketReady) {
      this.masters.set(host.id, { at: Date.now(), latencyMs })
      return { ok: true, reused: false, latencyMs, exitCode: r.exitCode }
    }
    if (socketReady && await this._masterAlive(host)) {
      this.masters.set(host.id, { at: Date.now(), latencyMs })
      return { ok: true, reused: false, latencyMs }
    }
    const cls = classifySshError(r.stderr || r.stdout, r.timedOut ? 'SSH connection timed out.' : 'SSH connection failed.')
    const message = r.timedOut ? 'SSH connection timed out.' : cls.message
    return {
      ok: false,
      code: r.timedOut ? 'TIMEOUT' : cls.code,
      message,
      latencyMs,
      needsPassword: (r.timedOut ? false : cls.code === 'AUTH') && !this.hasPassword(host.id),
      detail: shortText(r.stderr || r.stdout || (r.error && r.error.message) || '', 600),
    }
  }

  _muxFailure(text) {
    return /control socket|mux_client|multiplexed|connection closed|broken pipe|session open refused/i.test(String(text || ''))
  }

  /**
   * Run one non-interactive command over the shared connection.
   * Returns collected stdout/stderr plus an actionable error code.
   */
  async exec(host, command, { timeoutMs = 30000, maxBytes = 8 * 1024 * 1024, input = null } = {}) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const conn = await this.ensure(host, { force: attempt > 0 })
      if (!conn.ok) {
        return {
          ok: false,
          exitCode: null,
          stdout: '',
          stderr: '',
          code: conn.code,
          message: conn.message,
          needsPassword: conn.needsPassword,
          detail: conn.detail,
          latencyMs: conn.latencyMs,
        }
      }
      const ssh = await this._sh()
      const args = [
        ssh,
        '-S', this.socketPath(host),
        '-o', 'ControlMaster=no',
        '-o', 'BatchMode=yes',
        '-o', 'LogLevel=ERROR',
        ...this.targetArgs(host),
        command,
      ]
      const r = await this._run(args, { input, timeoutMs, maxBytes, env: {} })
      if (r.ok) {
        return { ok: true, exitCode: 0, stdout: r.stdout, stderr: r.stderr, truncated: r.truncated, latencyMs: conn.latencyMs }
      }
      const combined = `${r.stderr}\n${r.stdout}`
      if (attempt === 0 && this._muxFailure(combined)) {
        this.masters.delete(host.id)
        try { fs.rmSync(this.socketPath(host), { force: true }) } catch { /* ignore */ }
        continue
      }
      if (r.timedOut) {
        return { ok: false, exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr, code: 'TIMEOUT', message: `Remote command timed out after ${timeoutMs}ms.`, truncated: r.truncated }
      }
      const cls = classifySshError(combined, `Remote command exited with ${r.exitCode}`)
      return {
        ok: false,
        exitCode: r.exitCode,
        stdout: r.stdout,
        stderr: r.stderr,
        code: cls.code,
        message: cls.message,
        truncated: r.truncated,
      }
    }
    return { ok: false, exitCode: null, stdout: '', stderr: '', code: 'MUX', message: 'The shared SSH connection could not be re-established.' }
  }

  /**
   * Run one OpenSSH control command against the shared master (for example
   * `-O forward -L 127.0.0.1:8080:localhost:3000`). The forward lives in the
   * master process, so no extra local listener or child process is needed.
   */
  async control(host, args, { timeoutMs = 8000 } = {}) {
    const ssh = await this._sh()
    const conn = await this.ensure(host)
    if (!conn.ok) return { ok: false, code: conn.code, message: conn.message }
    const result = await this._run([
      ssh, '-S', this.socketPath(host), '-o', 'ControlMaster=no',
      ...args,
      ...this.targetArgs(host),
    ], { timeoutMs, maxBytes: 128 * 1024 })
    if (result.ok) return { ok: true, stdout: result.stdout, stderr: result.stderr }
    return {
      ok: false,
      code: 'FORWARD',
      message: (result.stderr || result.stdout || '').trim() || 'The SSH control command failed.',
      exitCode: result.exitCode,
    }
  }

  /** Build the argv a PTY backend uses to open an interactive SSH channel. */
  async ptyArgv(host, remoteCommand) {
    const ssh = await this._sh()
    return [
      ssh,
      '-tt',
      '-S', this.socketPath(host),
      '-o', 'ControlMaster=no',
      '-o', 'LogLevel=ERROR',
      '-o', 'ServerAliveInterval=20',
      ...this.targetArgs(host),
      remoteCommand,
    ]
  }

  ptyEnv(host) {
    return pickEnv({
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      ...this._askpassEnv(host),
    })
  }

  async disconnect(host) {
    const ssh = await this._sh().catch(() => null)
    if (!ssh) return
    try {
      await this._run([ssh, '-S', this.socketPath(host), '-o', 'ControlMaster=no', '-O', 'exit', ...this.targetArgs(host)], { timeoutMs: 4000, maxBytes: 32 * 1024 })
    } catch { /* ignore */ }
    this.masters.delete(host.id)
    this.passwords.delete(host.id)
  }

  async dispose() {
    for (const id of Array.from(this.masters.keys())) {
      const host = this.resolveHost(id)
      if (!host) continue
      await this.disconnect(host)
    }
    this.masters.clear()
    this.passwords.clear()
  }
}

export { sleep }
