import { describe, expect, it } from 'vitest'
import { contentWords, isCovered } from '../src/main/director/coverage'

describe('coverage', () => {
  it('removes stopwords and stems', () => {
    expect(contentWords('I was building the caching layers')).toEqual(['build', 'cach', 'layer'])
  })
  it('marks a point covered at >= 50% of content words', () => {
    expect(
      isCovered('Token bucket per API key', "I'd start with a token bucket for each key")
    ).toBe(true)
    expect(isCovered('Redis counters with TTL', 'we keep counters in Redis')).toBe(true)
  })
  it('does not mark unrelated points', () => {
    expect(
      isCovered('Sync quotas asynchronously between regions', 'I would use a token bucket')
    ).toBe(false)
  })
  it('handles numbers and empty points', () => {
    expect(isCovered('Cut p99 from 180 ms to 95 ms', 'we got p99 down to 95 from 180')).toBe(true)
    expect(isCovered('the and of', 'anything')).toBe(false)
  })
})
