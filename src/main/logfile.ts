// Append-only log file, rotated to `<file>.1` at ~1 MB, so problems can be diagnosed after the fact. No Electron imports.
import { appendFileSync, mkdirSync, renameSync, statSync } from 'fs'
import { dirname } from 'path'

const MAX_BYTES = 1_000_000

export function fileLogger(file: string): (line: string) => void {
  let size = 0
  try {
    size = statSync(file).size
  } catch {
    mkdirSync(dirname(file), { recursive: true })
  }
  return (line) => {
    try {
      if (size > MAX_BYTES) {
        renameSync(file, `${file}.1`)
        size = 0
      }
      const text = `${new Date().toISOString()} ${line}\n`
      appendFileSync(file, text)
      size += Buffer.byteLength(text)
    } catch {
      // logging must never break the app
    }
  }
}
