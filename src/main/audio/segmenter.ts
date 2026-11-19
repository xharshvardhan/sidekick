// Adaptive energy VAD that cuts one channel's PCM stream into speech segments. Pure, no Electron.
// Time comes from sample counts anchored to the capture helper's `ready` time.
import { SAMPLE_RATE, rms, rmsToLevel } from './wav'

export interface Segment {
  pcm: Int16Array // includes up to 300 ms pre-roll and a short tail
  startedAt: number // epoch ms of the first speech frame (pre-roll excluded)
  endedAt: number // epoch ms of the end of the last speech frame
  speechMs: number
}

export interface SegmenterOptions {
  onStart?: (at: number) => void
  onEnd?: (seg: Segment) => void
  /** A started segment turned out too short to keep (clears the speaking flag). */
  onDrop?: () => void
  /** Return true to treat this frame as non-speech (energy gate against echo). */
  suppress?: (frameRms: number) => boolean
  preRollMs?: number
  hangMs?: number
  maxMs?: number
  minSpeechMs?: number
  startSpeechMs?: number // speech needed before `onStart` fires (filters clicks)
  minRms?: number
}

const FRAME = 320 // 20 ms
const FRAME_MS = 20
const TAIL_MS = 200
const FLOOR_FRAMES = 150 // 3 s
const MAX_FLOOR = 600 // above this it is speech, not a noise bed (also covers streams that start mid-speech)

export class Segmenter {
  floor = 0
  lastRms = 0
  private peak = 0
  private recent: number[] = [] // frame rms, last 3 s
  private o: Required<Omit<SegmenterOptions, 'onStart' | 'onEnd' | 'onDrop' | 'suppress'>>
  private anchorAt = 0
  private sample = 0 // samples processed since anchor
  private pending = new Int16Array(0) // incomplete frame
  private history: Int16Array[] = [] // recent frames for pre-roll
  private seg: Int16Array[] | null = null
  private segStartSample = 0
  private lastSpeechSample = 0
  private speechFrames = 0
  private started = false

  constructor(private opts: SegmenterOptions = {}) {
    this.o = {
      preRollMs: opts.preRollMs ?? 300,
      hangMs: opts.hangMs ?? 550,
      maxMs: opts.maxMs ?? 15000,
      minSpeechMs: opts.minSpeechMs ?? 250,
      startSpeechMs: opts.startSpeechMs ?? 100,
      minRms: opts.minRms ?? 120
    }
  }

  /** Set the epoch time of the next sample (call on the helper's `ready`). Drops any open segment. */
  anchor(at: number): void {
    this.anchorAt = at
    this.sample = 0
    this.pending = new Int16Array(0)
    this.history = []
    this.recent = []
    this.seg = null
    this.started = false
  }

  get speaking(): boolean {
    return this.started
  }

  /** Peak meter level since the last call, 0..1. */
  takeLevel(): number {
    const l = rmsToLevel(this.peak)
    this.peak = 0
    return l
  }

  timeOf(sample: number): number {
    return this.anchorAt + (sample * 1000) / SAMPLE_RATE
  }

  push(chunk: Int16Array): void {
    let buf = chunk
    if (this.pending.length) {
      buf = new Int16Array(this.pending.length + chunk.length)
      buf.set(this.pending)
      buf.set(chunk, this.pending.length)
    }
    let i = 0
    for (; i + FRAME <= buf.length; i += FRAME) this.frame(buf.slice(i, i + FRAME))
    this.pending = buf.slice(i)
  }

  /** Close any open segment (e.g. when capture stops). */
  flush(): void {
    if (this.seg) this.close()
  }

  private frame(f: Int16Array): void {
    const r = rms(f)
    this.lastRms = r
    if (r > this.peak) this.peak = r
    // Noise floor = quietest frame of the last 3 s: speech always has dips, a steady noise bed does not.
    this.recent.push(r)
    if (this.recent.length > FLOOR_FRAMES) this.recent.shift()
    this.floor = Math.min(MAX_FLOOR, ...this.recent)
    const threshold = Math.max(this.floor * 3, this.o.minRms)
    const speech = r > threshold && !(this.opts.suppress?.(r) ?? false)

    const frameStart = this.sample
    this.sample += FRAME

    if (!this.seg) {
      this.history.push(f)
      const keep = Math.ceil(this.o.preRollMs / FRAME_MS)
      if (this.history.length > keep + 1) this.history.shift()
      if (!speech) return
      // open a segment: pre-roll is the history before this frame
      this.seg = this.history.slice()
      this.history = []
      this.segStartSample = frameStart
      this.lastSpeechSample = this.sample
      this.speechFrames = 1
      this.started = false
    } else {
      this.seg.push(f)
      if (speech) {
        this.speechFrames++
        this.lastSpeechSample = this.sample
      }
    }

    const speechMs = this.speechFrames * FRAME_MS
    if (!this.started && speechMs >= this.o.startSpeechMs) {
      this.started = true
      this.opts.onStart?.(this.timeOf(this.segStartSample))
    }
    const silentMs = ((this.sample - this.lastSpeechSample) * 1000) / SAMPLE_RATE
    const lenMs = ((this.sample - this.segStartSample) * 1000) / SAMPLE_RATE
    if (silentMs >= this.o.hangMs || lenMs >= this.o.maxMs) this.close()
  }

  private close(): void {
    const frames = this.seg!
    const speechMs = this.speechFrames * FRAME_MS
    // trim trailing silence down to a short tail
    const tailFrames = Math.ceil(TAIL_MS / FRAME_MS)
    const silentFrames = Math.round((this.sample - this.lastSpeechSample) / FRAME)
    const keep = frames.length - Math.max(0, silentFrames - tailFrames)
    const pcm = new Int16Array(keep * FRAME)
    for (let k = 0; k < keep; k++) pcm.set(frames[k], k * FRAME)
    const seg: Segment = {
      pcm,
      startedAt: this.timeOf(this.segStartSample),
      endedAt: this.timeOf(this.lastSpeechSample),
      speechMs
    }
    this.seg = null
    const wasStarted = this.started
    this.started = false
    if (!wasStarted) return
    if (speechMs >= this.o.minSpeechMs) this.opts.onEnd?.(seg)
    else this.opts.onDrop?.()
  }
}
