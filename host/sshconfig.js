// Parse ~/.ssh/config into connectable host entries.
//
// We deliberately keep the parser small: OpenSSH itself resolves the connection
// (HostName/User/Port/IdentityFile/ProxyJump/ProxyCommand/include wildcards),
// while this module only needs enough information to LIST hosts and show a
// truthful user@host:port row. Include directives, Host patterns, defaults from
// `Host *`, and quoted values are handled; Match blocks are skipped.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expandHome } from './util.js'

const MAX_DEPTH = 8

function stripComment(line) {
  const s = line.trim()
  if (!s || s.startsWith('#')) return ''
  return s
}

function unquote(v) {
  let s = v.trim()
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1)
  }
  return s
}

function splitKV(line) {
  let i = 0
  while (i < line.length && !/\s|=/.test(line[i])) i++
  const key = line.slice(0, i).toLowerCase()
  let rest = line.slice(i)
  rest = rest.replace(/^\s*=?\s*/, '')
  return [key, unquote(rest)]
}

function globToRegExp(pattern) {
  let out = '^'
  for (const ch of pattern) {
    if (ch === '*') out += '[^/]*'
    else if (ch === '?') out += '[^/]'
    else out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(out + '$')
}

function expandInclude(pattern, baseDir) {
  let p = expandHome(pattern)
  if (!path.isAbsolute(p)) p = path.join(baseDir, p)
  if (!/[*?]/.test(p)) return fs.existsSync(p) ? [p] : []
  const dir = path.dirname(p)
  const mask = path.basename(p)
  let names = []
  try {
    names = fs.readdirSync(dir)
  } catch {
    return []
  }
  const re = globToRegExp(mask)
  return names.filter((n) => re.test(n)).map((n) => path.join(dir, n)).sort()
}

function parseFile(file, ctx, depth) {
  if (depth > MAX_DEPTH) return
  let real = file
  try {
    real = fs.realpathSync(file)
  } catch {
    return
  }
  if (ctx.seen.has(real)) return
  ctx.seen.add(real)

  let text = ''
  try {
    text = fs.readFileSync(real, 'utf8')
  } catch (err) {
    ctx.warnings.push(`Cannot read ${real}: ${err.message}`)
    return
  }

  let block = null
  const defaults = ctx.defaults
  for (const raw of text.split(/\r?\n/)) {
    const line = stripComment(raw)
    if (!line) continue
    const [key, value] = splitKV(line)
    if (key === 'include') {
      for (const part of value.split(/\s+/).filter(Boolean)) {
        for (const inc of expandInclude(part, path.dirname(real))) parseFile(inc, ctx, depth + 1)
      }
      continue
    }
    if (key === 'host') {
      const patterns = value.split(/\s+/).filter(Boolean)
      const literal = patterns.filter((p) => !/[*?!]/.test(p))
      const wildcard = patterns.length !== literal.length
      block = { patterns, literal, wildcard, options: {} }
      ctx.blocks.push(block)
      continue
    }
    if (key === 'match') {
      block = { patterns: [], literal: [], wildcard: true, options: {}, match: true }
      ctx.blocks.push(block)
      continue
    }
    if (!block) {
      // Global options before the first Host block are defaults in OpenSSH too.
      if (!(key in defaults)) defaults[key] = value
      continue
    }
    if (block.match) continue
    if (!(key in block.options)) block.options[key] = value
    // A `Host *` block is a defaults block. Record its options as defaults,
    // first occurrence wins, matching OpenSSH's "first obtained value" rule.
    if (block.wildcard && !block.literal.length && !(key in defaults)) defaults[key] = value
  }
}

function pick(options, defaults, key) {
  if (options && options[key] !== undefined && options[key] !== '') return options[key]
  if (defaults[key] !== undefined && defaults[key] !== '') return defaults[key]
  return ''
}

/**
 * @returns {{ hosts: Array<object>, defaults: object, configPath: string, warnings: string[] }}
 */
export function parseSshConfig(configPath) {
  const file = expandHome(configPath || path.join(os.homedir(), '.ssh', 'config'))
  const ctx = { blocks: [], defaults: {}, warnings: [], seen: new Set() }
  if (fs.existsSync(file)) parseFile(file, ctx, 0)
  else ctx.warnings.push(`SSH config not found at ${file}`)

  const seen = new Set()
  const hosts = []
  for (const block of ctx.blocks) {
    if (block.match || !block.literal || !block.literal.length) continue
    for (const alias of block.literal) {
      if (seen.has(alias)) continue
      seen.add(alias)
      const opts = block.options || {}
      const hostName = pick(opts, ctx.defaults, 'hostname') || alias
      const user = pick(opts, ctx.defaults, 'user')
      const portRaw = pick(opts, ctx.defaults, 'port')
      const port = Number(portRaw) > 0 ? Number(portRaw) : 22
      const identity = pick(opts, ctx.defaults, 'identityfile')
      const proxy = pick(opts, ctx.defaults, 'proxyjump')
      const proxyCommand = pick(opts, ctx.defaults, 'proxycommand')
      hosts.push({
        id: `cfg:${alias}`,
        alias,
        name: alias,
        source: 'ssh-config',
        hostName,
        user,
        port,
        identityFile: identity ? expandHome(identity.split(/\s+/)[0]) : '',
        proxyJump: proxy,
        proxyCommand,
        detail: `${user ? user + '@' : ''}${hostName}:${port}`,
      })
    }
  }

  return { hosts, defaults: ctx.defaults, configPath: file, warnings: ctx.warnings }
}
