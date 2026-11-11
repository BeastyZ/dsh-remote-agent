// Native macOS notifications are deliberately sent from the local Host, never
// by the remote server. execFile argv is isolated through the OSA receiver's
// on-run handler arguments; no terminal title can become executable AppleScript.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execute = promisify(execFile)
const NOTIFY_SCRIPT = `
on run argv
    if (count of argv) < 2 then error "notification title/body missing"
    display notification (item 2 of argv) with title (item 1 of argv) sound name "Glass"
end run
`

export class LocalNotifier {
  constructor({ platform = process.platform, run = execute } = {}) {
    this.platform = platform
    this.run = run
  }

  capability() {
    return {
      platform: this.platform,
      available: this.platform === 'darwin',
      reason: this.platform === 'darwin' ? '' : 'Native notifications are currently supported on macOS only.',
    }
  }

  async send({ title = 'Remote agent', body = '' } = {}) {
    this.available()
    // Use OSA positional arguments -- NOT interpolated display-notification
    // source -- because JSON syntax is not the AppleScript string grammar.
    const args = ['-l', 'AppleScript', '-e', NOTIFY_SCRIPT, String(title).slice(0, 200), String(body).slice(0, 500)]
    const sink = this.run('/usr/bin/osascript', args, { timeout: 10000, windowsHide: true })
    await sink
    return { ok: true, platform: this.platform }
  }

  available() {
    if (this.platform !== 'darwin') throw Object.assign(new Error('Native notifications are currently supported on macOS only.'), { code: 'UNSUPPORTED' })
  }
}
