import { createWriteStream, mkdirSync, renameSync, statSync, type WriteStream } from 'node:fs'
import { dirname } from 'node:path'

const MAX_BYTES = 5 * 1024 * 1024

/** Append-only log file, rotated to `<file>.1` when it grows past 5 MB at open time. */
export class LogFile {
  private stream: WriteStream | null = null

  constructor(readonly path: string) {}

  open(): void {
    if (this.stream) return
    mkdirSync(dirname(this.path), { recursive: true })
    try {
      if (statSync(this.path).size > MAX_BYTES) renameSync(this.path, `${this.path}.1`)
    } catch {
      // no previous log
    }
    this.stream = createWriteStream(this.path, { flags: 'a' })
    this.stream.on('error', () => {
      this.stream = null
    })
  }

  line(text: string): void {
    this.write(`[${new Date().toISOString()}] ${text}\n`)
  }

  write(chunk: string | Buffer): void {
    if (!this.stream) this.open()
    this.stream?.write(chunk)
  }

  close(): Promise<void> {
    const stream = this.stream
    this.stream = null
    if (!stream) return Promise.resolve()
    return new Promise((resolve) => stream.end(() => resolve()))
  }
}
