// Audio sources: the `audiocap` helper (restarted with backoff) or a fake PCM file played in real time.
// No Electron imports, so the headless sim uses the same code.
import { spawn, type ChildProcess } from 'child_process'
import { readFileSync } from 'fs'
import { SAMPLE_RATE } from './wav'

export type CaptureStatus = 'starting' | 'ok' | 'denied' | 'error'

export interface CaptureHandlers {
  onReady: (at: number) => void // epoch ms of the first sample that follows
  onData: (pcm: Int16Array) => void
  onStatus: (status: CaptureStatus, message?: string) => void
}

export interface Capture {
  stop(): void
}

// ScreenCaptureKit lists no displays when Screen Recording is not granted, so "no display" means denied too
const DENIED = /permission|tcc|not authori[sz]ed|declined|denied|no display/i

/** Spawn `audiocap <args>`; restart it with backoff whenever it exits until `stop()`, unless it exits for lack of permission. */
export function spawnCapture(bin: string, args: string[], h: CaptureHandlers): Capture {
  let child: ChildProcess | null = null
  let stopped = false
  let backoff = 1000
  let timer: NodeJS.Timeout | null = null
  let lastError = ''

  const start = (): void => {
    h.onStatus('starting')
    let readyAt = 0
    let carry: Buffer | null = null
    let proc: ChildProcess
    try {
      proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e) {
      h.onStatus('error', `could not start audio helper: ${(e as Error).message}`)
      return schedule()
    }
    child = proc
    // output from a retired helper (stopped, or replaced by a restart) must not reach the channel
    const live = (): boolean => !stopped && child === proc
    proc.stdout!.on('data', (b: Buffer) => {
      if (!live()) return
      if (!readyAt) {
        readyAt = Date.now()
        h.onReady(readyAt)
      }
      if (carry) {
        b = Buffer.concat([carry, b])
        carry = null
      }
      if (b.length % 2) {
        carry = b.subarray(b.length - 1)
        b = b.subarray(0, b.length - 1)
      }
      // copy so the Int16Array is aligned and owns its memory
      const copy = Buffer.from(b)
      h.onData(new Int16Array(copy.buffer, copy.byteOffset, copy.length / 2))
    })
    proc.stderr!.setEncoding('utf8')
    proc.stderr!.on('data', (text: string) => {
      if (!live()) return
      for (const line of text
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)) {
        if (line.startsWith('ready')) {
          // mic prints "ready 1ch 48000Hz"
          if (!readyAt) {
            readyAt = Date.now()
            h.onReady(readyAt)
          }
          h.onStatus('ok')
          lastError = ''
        } else if (line.startsWith('error:') || line.startsWith('stopped:')) {
          lastError = line.replace(/^(error|stopped):\s*/, '')
          h.onStatus(DENIED.test(lastError) ? 'denied' : 'error', lastError)
        }
      }
    })
    // 'exit' or 'error' (a failed spawn emits only 'error'): handle whichever comes first, once
    const ended = (why: string): void => {
      if (!live()) return
      child = null
      if (readyAt && Date.now() - readyAt > 10_000) backoff = 1000 // it ran fine for a while
      // a missing permission does not fix itself: stop here; the engine restarts once it is granted
      if (DENIED.test(why)) return h.onStatus('denied', why)
      h.onStatus('error', `audio helper ${why}; restarting`)
      schedule()
    }
    proc.on('error', (e) => ended(lastError || `failed: ${e.message}`))
    proc.on('exit', (code, signal) => ended(lastError || `exited (${signal ?? code})`))
  }

  const schedule = (): void => {
    if (stopped) return
    timer = setTimeout(start, backoff)
    backoff = Math.min(backoff * 2, 15_000)
  }

  start()
  return {
    stop() {
      stopped = true
      if (timer) clearTimeout(timer)
      child?.kill('SIGTERM')
      child = null
    }
  }
}

/** Play a raw PCM16 16 kHz mono file in real time, then keep sending digital silence. */
export function fakeCapture(file: string, h: CaptureHandlers, startAt = Date.now()): Capture {
  let pcm: Int16Array
  try {
    const b = readFileSync(file)
    pcm = new Int16Array(b.buffer, b.byteOffset, Math.floor(b.length / 2))
  } catch (e) {
    h.onStatus('error', `fake audio: ${(e as Error).message}`)
    return { stop: () => undefined }
  }
  let sent = 0
  const begin = (): void => {
    h.onStatus('ok')
    h.onReady(startAt)
  }
  const tick = (): void => {
    const due = Math.floor(((Date.now() - startAt) * SAMPLE_RATE) / 1000)
    if (due <= sent) return
    const out = new Int16Array(due - sent)
    if (sent < pcm.length) out.set(pcm.subarray(sent, Math.min(due, pcm.length)))
    sent = due
    h.onData(out)
  }
  const delay = Math.max(0, startAt - Date.now())
  let timer: NodeJS.Timeout | null = null
  const t0 = setTimeout(() => {
    begin()
    timer = setInterval(tick, 50)
  }, delay)
  return {
    stop() {
      clearTimeout(t0)
      if (timer) clearInterval(timer)
    }
  }
}
