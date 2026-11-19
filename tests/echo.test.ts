import { describe, expect, it } from 'vitest'
import { isEcho, isEchoFrame } from '../src/main/audio/echo'
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

describe('echo guard: replies right after them', () => {
  const them = [u('them', "Great, so let's lock it in for Friday", 1000, 3000)]
  it('keeps "Friday" said 200 ms after they finish', () => {
    expect(isEcho(u('you', 'Friday', 3200, 3600), them)).toBe(false)
  })
  it('drops "Friday" that overlaps their speech', () => {
    expect(isEcho(u('you', 'Friday', 2500, 2950), them)).toBe(true)
  })
})

describe('energy gate', () => {
  describe('with echo cancellation', () => {
    it('drops quiet residual echo while the call is audible', () => {
      expect(isEchoFrame(250, 3000, true)).toBe(true)
    })
    it('keeps the user talking loudly over the other side', () => {
      expect(isEchoFrame(2500, 6000, true)).toBe(false)
    })
    it('keeps normal speech even when the call is louder', () => {
      expect(isEchoFrame(900, 8000, true)).toBe(false)
    })
    it('keeps quiet speech when the call is silent', () => {
      expect(isEchoFrame(200, 100, true)).toBe(false)
    })
  })
  describe('without echo cancellation', () => {
    it('drops mic speech much quieter than the speakers', () => {
      expect(isEchoFrame(1000, 3000, false)).toBe(true)
    })
    it('keeps the user speaking over the other side', () => {
      expect(isEchoFrame(2500, 3000, false)).toBe(false)
    })
    it('keeps quiet speech when the call is silent', () => {
      expect(isEchoFrame(200, 100, false)).toBe(false)
    })
  })
})
