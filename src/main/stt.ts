// Segment → text with the STT model. No Electron imports.
import { audioPart, generateText, type Llm } from './llm'
import { pcmToWav, rms } from './audio/wav'

const HALLUCINATIONS = new Set([
  '',
  'you',
  'thank you',
  'thanks',
  'thank you for watching',
  'thanks for watching',
  'bye',
  'okay',
  'uh',
  'um',
  'hmm'
])

export async function transcribe(
  ai: Llm,
  model: string,
  pcm: Int16Array,
  language: string
): Promise<string> {
  const lang = language ? ` The speech is most likely in ${language}.` : ''
  const text = await generateText(ai, {
    model,
    maxTokens: 600,
    parts: [
      audioPart(pcmToWav(pcm)),
      {
        text:
          'Transcribe this audio verbatim, in the language spoken.' +
          lang +
          ' Output only the transcript text: no labels, quotes, timestamps or notes.' +
          ' If there is no intelligible speech, output nothing.'
      }
    ]
  })
  return cleanTranscript(text, rms(pcm))
}

/** Drop empty output and the usual hallucinations on near-silent audio. */
export function cleanTranscript(text: string, level: number): string {
  const t = text
    .trim()
    .replace(/^["'“]|["'”]$/g, '')
    .trim()
  if (/^[\s\p{P}]*$/u.test(t)) return ''
  if (/^[([].*[)\]]$/.test(t)) return '' // "(no speech)", "[inaudible]"
  const norm = t
    .toLowerCase()
    .replace(/[^\p{L}\s]/gu, '')
    .trim()
  if (level < 400 && HALLUCINATIONS.has(norm)) return ''
  return t
}
