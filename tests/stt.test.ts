import { describe, expect, it } from 'vitest'
import { callLanguage, cleanTranscript } from '../src/main/stt'

describe('cleanTranscript', () => {
  it('drops sound tags, the no-speech marker, timestamps and pure filler', () => {
    for (const t of [
      '<noise>',
      '[music]',
      'NO_SPEECH',
      'No speech.',
      '00:00',
      '0:00',
      'um',
      'Mhm.',
      'Hmm...',
      'uh-huh',
      'Um, uh.',
      'mm-hmm'
    ])
      expect(cleanTranscript(t, 2000), t).toBe('')
  })
  it('keeps short real answers and strips inline tags', () => {
    for (const t of ['Yes.', 'Okay.', 'No.', 'Got it.', 'नहीं', '20'])
      expect(cleanTranscript(t, 2000), t).toBe(t)
    expect(cleanTranscript('Um, I think <noise> we should', 2000)).toBe('Um, I think we should')
  })
})

describe('callLanguage', () => {
  it('names the script the call has been in, or nothing when unsure', () => {
    expect(
      callLanguage(['Can you walk me through the setup?', 'Sure, first I set the region.'])
    ).toMatch(/^English/)
    expect(callLanguage(['मुझे लगता है कि यह तरीका सही है', 'हाँ ठीक है, आगे बढ़ते हैं'])).toBe('Hindi')
    expect(callLanguage(['ok'])).toBe('')
  })
})
