// One atomic, private checkpoint per terminal. Records are removed only by an
// explicit delete; process exit, detach and Host shutdown just update them.
import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'

const VALID_ID = /^t-[a-f0-9]{12}$/
export const RING_CHARS = 512 * 1024

export class TerminalArchive {
  constructor(dir) {
    this.dir = dir
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  }

  file(id) {
    if (!VALID_ID.test(id)) throw new Error('Invalid terminal archive id.')
    return path.join(this.dir, `${id}.json`)
  }

  load() {
    const records = []
    for (const name of fs.readdirSync(this.dir)) {
      if (!/^t-[a-f0-9]{12}\.json$/.test(name)) continue
      try {
        const record = JSON.parse(fs.readFileSync(path.join(this.dir, name), 'utf8'))
        if (record.version !== 1 || `${record.id}.json` !== name ||
            typeof record.hostId !== 'string' || typeof record.cwd !== 'string') continue
        records.push(record)
      } catch (error) {
        // A damaged record must not discard other sessions or be overwritten.
        console.warn('[dsh-remote-agent] cannot read terminal archive:', name, error.message)
      }
    }
    return records.sort((a, b) => a.createdAt - b.createdAt)
  }

  save(record) {
    const file = this.file(record.id)
    const tmp = path.join(this.dir, `.${record.id}-${randomBytes(4).toString('hex')}.tmp`)
    fs.writeFileSync(tmp, JSON.stringify({ ...record, version: 1 }), { mode: 0o600 })
    fs.renameSync(tmp, file)
  }

  migrationFile(id) {
    if (!/^[a-z0-9-]{1,80}$/.test(id)) throw new Error('Invalid migration id.')
    return path.join(this.dir, `.imported-${id}`)
  }

  hasMigration(id) { return fs.existsSync(this.migrationFile(id)) }
  markMigration(id) { fs.writeFileSync(this.migrationFile(id), '1', { mode: 0o600 }) }

  remove(id) {
    // file() validates the id; this is always one record inside our archive.
    fs.unlinkSync(this.file(id))
  }
}
