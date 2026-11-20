import { describe, expect, it } from 'vitest'
import { PROFILE_HEADINGS, profileInstructions, sessionSelfText } from '../src/main/profile'

describe('profile prompt', () => {
  it('lists every heading and carries the current profile', () => {
    const p = profileInstructions('Priya, 6 years backend')
    for (const h of PROFILE_HEADINGS) expect(p).toContain(h)
    expect(p).toContain('Priya, 6 years backend')
    expect(p).toContain('Never invent')
    expect(p).toContain('(check)')
  })
  it('marks an empty profile', () => {
    expect(profileInstructions('  ')).toContain('(empty)')
  })
  it('keeps only what "you" said', () => {
    const text = sessionSelfText({
      title: 'Call',
      utterances: [
        { id: '1', speaker: 'them', text: 'Tell me about yourself', startedAt: 0, endedAt: 1 },
        { id: '2', speaker: 'you', text: 'I led the settlement rewrite.', startedAt: 2, endedAt: 3 }
      ]
    })
    expect(text).toContain('settlement rewrite')
    expect(text).not.toContain('Tell me about yourself')
  })
  it('is empty when the user said nothing', () => {
    expect(sessionSelfText({ title: 'x', utterances: [] })).toBe('')
  })
})
