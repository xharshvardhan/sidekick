import { describe, expect, it } from 'vitest'
import { isEcho } from '../src/main/audio/echo'
import type { Utterance } from '../src/shared/types'

const u = (
  speaker: 'you' | 'them',
  text: string,
  startedAt: number,
  endedAt: number
): Utterance => ({
  id: `${speaker}${startedAt}`,
  speaker,
  text,
  startedAt,
  endedAt
})

describe('echo guard', () => {
  const them = [u('them', 'How would you design a rate limiter for a public API?', 1000, 4000)]
  it('drops a you utterance that overlaps and repeats their words', () => {
    expect(isEcho(u('you', 'design a rate limiter for a public API', 1500, 3800), them)).toBe(true)
  })
  it('keeps a real answer that overlaps in time', () => {
    expect(isEcho(u('you', 'Sure, I would start with a token bucket', 3500, 6000), them)).toBe(
      false
    )
  })
  it('keeps repeated words when not overlapping in time', () => {
    expect(isEcho(u('you', 'design a rate limiter for a public API', 9000, 11000), them)).toBe(
      false
    )
  })
})
