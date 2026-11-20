import { describe, expect, it } from 'vitest'
import { parseCue } from '../src/main/director/protocol'

const FULL = `@new
> I'd use a token bucket per API key, backed by Redis.
- Token bucket per key
- Redis counters with TTL
- Lua script for atomicity
? Design a rate limiter
##
\`\`\`lua
-- check
\`\`\`
`

describe('parseCue', () => {
  it('parses a full reply', () => {
    const p = parseCue(FULL, true)
    expect(p.kind).toBe('new')
    expect(p.say).toBe("I'd use a token bucket per API key, backed by Redis.")
    expect(p.points).toEqual([
      'Token bucket per key',
      'Redis counters with TTL',
      'Lua script for atomicity'
    ])
    expect(p.prompt).toBe('Design a rate limiter')
    expect(p.detail).toBe('```lua\n-- check\n```')
    expect(p.sayDone).toBe(true)
  })

  it('streams: every prefix parses, and say only grows', () => {
    let prev = ''
    for (let i = 1; i <= FULL.length; i++) {
      const p = parseCue(FULL.slice(0, i))
      expect(p.say.startsWith(prev.trim()) || prev === '').toBe(true)
      prev = p.say
    }
  })

  it('waits for a whole directive word, and shows a partial say line', () => {
    expect(parseCue('@ne').kind).toBeNull()
    expect(parseCue('@new').kind).toBe('new')
    const p = parseCue('@extend\n> And across regions I wo')
    expect(p.kind).toBe('extend')
    expect(p.say).toBe('And across regions I wo')
    expect(p.sayDone).toBe(false)
    expect(parseCue('@extend\n> And across regions.\n-').sayDone).toBe(true)
  })

  it('handles @none, junk before the directive and code fences', () => {
    expect(parseCue('@none', true).kind).toBe('none')
    expect(parseCue('Sure! Here you go:\n```\n@none\n```', true).kind).toBe('none')
    const p = parseCue('thinking...\n@new\n> Hello there.\n- a point', true)
    expect(p.kind).toBe('new')
    expect(p.say).toBe('Hello there.')
  })

  it('tolerates missing sections and old-style labels', () => {
    const p = parseCue('@new What is your notice period\n> Thirty days.', true)
    expect(p.prompt).toBe('What is your notice period')
    expect(p.points).toEqual([])
    expect(p.detail).toBe('')
    expect(parseCue('> No directive at all.', true).kind).toBe('new')
    expect(parseCue('@new\nForgot the marker.', true).say).toBe('Forgot the marker.')
  })

  it('ignores content after @none', () => {
    const p = parseCue('@none\n> should not show', true)
    expect(p.kind).toBe('none')
    expect(p.say).toBe('')
  })
})

describe('parseCue +deep marker', () => {
  const BODY = `> The decoder generates one token at a time, attending to itself causally and to the encoder.
- Masked self-attention over generated tokens
- Cross-attention: Q from decoder, K and V from encoder
? Explain the transformer decoder`

  it('is off by default', () => {
    expect(parseCue(FULL, true).deep).toBe(false)
  })

  it('is read after the label, before the points, after the directive, or at the very end', () => {
    for (const text of [
      `@new\n${BODY}\n+deep\n`,
      `@new\n+deep\n${BODY}`,
      `@new +deep\n${BODY}`,
      `@new\n${BODY}\n##\nsome detail\n+deep`
    ]) {
      const p = parseCue(text, true)
      expect(p.deep).toBe(true)
      expect(p.say).toMatch(/^The decoder generates/)
      expect(p.points).toHaveLength(2)
      expect(p.prompt).toBe('Explain the transformer decoder')
      expect(p.detail).not.toContain('+deep')
    }
  })

  it('a partial marker never shows up as the say line, a point or detail', () => {
    for (const cut of ['+', '+d', '+dee', '+deep']) {
      const before = parseCue(`@new\n${cut}`)
      expect(before.say).toBe('')
      expect(before.deep).toBe(false) // only once the line is complete
      const after = parseCue(`@new\n${BODY}\n##\nx\n${cut}`)
      expect(after.detail).toBe('x')
    }
    expect(parseCue(`@new\n+deep\n> Hi`).deep).toBe(true)
  })

  it('every streamed prefix keeps say growing and deep turns on once', () => {
    const text = `@new\n+deep\n${BODY}\n`
    let seen = false
    let prev = ''
    for (let i = 1; i <= text.length; i++) {
      const p = parseCue(text.slice(0, i))
      expect(p.say.startsWith(prev)).toBe(true)
      prev = p.say
      if (seen) expect(p.deep).toBe(true)
      seen ||= p.deep
    }
    expect(seen).toBe(true)
  })

  it('is ignored on @none', () => {
    expect(parseCue('@none\n+deep', true).deep).toBe(false)
  })
})
