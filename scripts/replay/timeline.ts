// Shared by the replay scripts: the call.json / gold.json formats and the live segmenter's cut rule on word timings.
import { readFileSync } from 'fs'
import { join } from 'path'
import type { Speaker } from '../../src/shared/types'

export type Word = [text: string, start: number, end: number] // seconds
export interface CallUtterance {
  speaker: Speaker
  start: number
  end: number
  text: string
  words: Word[]
}
export interface CallFile {
  duration: number
  utterances: CallUtterance[]
}

/** One stretch of speech as the live segmenter would cut it. */
export interface Seg {
  speaker: Speaker
  start: number
  end: number
  text: string
  utt: number // index of its utterance in call.json
  last: boolean // the utterance ends here (the other person speaks next)
}

export type GoldLabel = 'cue' | 'optional' | 'none'
export interface GoldMoment {
  t: number // end of their speech segment, seconds
  said: string // the segment's words
  label: GoldLabel
  kind?: 'new' | 'extend' // cue only
  note?: string // what a strong card would contain
  answer?: string // what the user actually said next (summary)
}

// The live segmenter's defaults (src/main/audio/segmenter.ts): a segment ends after 550 ms of silence or at 15 s.
export const HANG_S = 0.55
export const MAX_S = 15

/** Cut every utterance where a word gap reaches the end-silence, or where the segment would pass 15 s. */
export function segments(call: CallFile): Seg[] {
  const out: Seg[] = []
  call.utterances.forEach((u, utt) => {
    let cur: Word[] = []
    const close = (): void => {
      if (!cur.length) return
      out.push({
        speaker: u.speaker,
        start: cur[0][1],
        end: cur[cur.length - 1][2],
        text: cur.map((w) => w[0]).join(' '),
        utt,
        last: false
      })
      cur = []
    }
    for (const w of u.words) {
      const prev = cur[cur.length - 1]
      if (prev && (w[1] - prev[2] >= HANG_S || w[2] - cur[0][1] > MAX_S)) close()
      cur.push(w)
    }
    close()
    out[out.length - 1].last = true
  })
  return out
}

export const loadCall = (dir: string): CallFile =>
  JSON.parse(readFileSync(join(dir, 'call.json'), 'utf8')) as CallFile

export const mmss = (s: number): string =>
  `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`

export function parseMmss(v: string): number {
  const [m, s] = v.split(':').map(Number)
  return s === undefined ? m : m * 60 + s
}

/** Run `fn` over items with at most `n` in flight. */
export async function pool<T, R>(
  items: T[],
  n: number,
  fn: (x: T, i: number) => Promise<R>
): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++
        out[i] = await fn(items[i], i)
      }
    })
  )
  return out
}

/** Parse a model's JSON reply, tolerating a ```json fence. */
export const parseJson = <T>(text: string): T =>
  JSON.parse(text.replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, '')) as T
