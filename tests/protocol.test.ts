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
