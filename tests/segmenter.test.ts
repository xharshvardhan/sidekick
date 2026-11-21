import { describe, expect, it } from 'vitest'
import { Segmenter, type Segment } from '../src/main/audio/segmenter'
import { pcmToWav, wavToPcm } from '../src/main/audio/wav'

const SR = 16000
const tone = (ms: number, amp = 3000): Int16Array =>
  Int16Array.from({ length: (ms * SR) / 1000 }, (_, i) =>
    Math.round(amp * Math.sin((2 * Math.PI * 220 * i) / SR))
  )
const silence = (ms: number, noise = 0): Int16Array =>
  Int16Array.from({ length: (ms * SR) / 1000 }, () => Math.round((Math.random() * 2 - 1) * noise))

function run(
  chunks: Int16Array[],
  chunkMs = 37
): { segs: Segment[]; starts: number[]; drops: number } {
  const segs: Segment[] = []
  const starts: number[] = []
  let drops = 0
  const s = new Segmenter({
    onStart: (t) => starts.push(t),
    onEnd: (x) => segs.push(x),
    onDrop: () => drops++
  })
  s.anchor(1_000_000)
  // feed in odd-sized chunks to exercise frame buffering
  const all = Int16Array.from(chunks.flatMap((c) => Array.from(c)))
  const n = (chunkMs * SR) / 1000
  for (let i = 0; i < all.length; i += n) s.push(all.slice(i, i + n))
  return { segs, starts, drops }
}

describe('Segmenter', () => {
  it('typing (short clicks, never 100 ms unbroken) opens no segment', () => {
    const click = (): Int16Array =>
      Int16Array.from({ length: 160 }, (_, i) => Math.round(6000 * Math.exp(-i / 32) * Math.sin(i)))
    const typing: Int16Array[] = []
    for (let k = 0; k < 24; k++) typing.push(click(), silence(110, 20)) // ~8 keys per second for 3 s
    const { segs, starts } = run([silence(1000, 20), ...typing, silence(1000, 20)])
    expect(starts).toHaveLength(0)
    expect(segs).toHaveLength(0)
  })

  it('cuts one segment with timestamps from sample counts and pre-roll', () => {
    const { segs, starts } = run([silence(1000, 20), tone(1500), silence(1000, 20)])
    expect(segs).toHaveLength(1)
    expect(starts).toHaveLength(1)
    const s = segs[0]
    expect(s.startedAt).toBeGreaterThanOrEqual(1_000_000 + 980)
    expect(s.startedAt).toBeLessThanOrEqual(1_000_000 + 1020)
    expect(s.endedAt).toBeGreaterThanOrEqual(1_000_000 + 2480)
    expect(s.endedAt).toBeLessThanOrEqual(1_000_000 + 2520)
    // 300 ms pre-roll + 1500 ms speech + ≤ 200 ms tail
    const ms = (s.pcm.length / SR) * 1000
    expect(ms).toBeGreaterThan(1700)
    expect(ms).toBeLessThan(2100)
  })

  it('ends on 550 ms of silence, not on shorter pauses', () => {
    const short = run([tone(800), silence(400), tone(800), silence(1000)])
    expect(short.segs).toHaveLength(1)
    const long = run([tone(800), silence(700), tone(800), silence(1000)])
    expect(long.segs).toHaveLength(2)
  })

  it('drops clicks shorter than 250 ms of speech', () => {
    const { segs, drops } = run([silence(500), tone(160), silence(1000)])
    expect(segs).toHaveLength(0)
    expect(drops).toBe(1) // it had fired onStart (>=100 ms) so it reports the drop
  })

  it('splits a monologue at 15 s', () => {
    // speech-like: 900 ms bursts with 100 ms dips (shorter than the 550 ms hang)
    const talk = Array.from({ length: 34 }, (_, i) => (i % 2 ? silence(100, 20) : tone(900)))
    const { segs } = run([...talk, silence(1000)])
    expect(segs.length).toBe(2)
    expect(segs[0].endedAt - segs[0].startedAt).toBeLessThanOrEqual(15000)
  })

  it('adapts to a noise floor', () => {
    const { segs } = run([silence(2000, 300), tone(1000, 6000), silence(1000, 300)])
    expect(segs).toHaveLength(1)
  })

  it('suppress() gates frames out (echo energy gate)', () => {
    const segs: Segment[] = []
    const s = new Segmenter({ onEnd: (x) => segs.push(x), suppress: () => true })
    s.anchor(0)
    s.push(tone(1000))
    s.push(silence(1000))
    expect(segs).toHaveLength(0)
  })

  it('wav round trip', () => {
    const pcm = tone(100)
    expect(Array.from(wavToPcm(pcmToWav(pcm)))).toEqual(Array.from(pcm))
  })
})
