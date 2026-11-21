// Segment → text with the STT model. No Electron imports.
import { audioPart, generateText, type Llm } from './llm'
import { pcmToWav, rms } from './audio/wav'

const HALLUCINATIONS = new Set([
  'you',
  'thank you',
  'thanks',
  'thank you for watching',
  'thanks for watching',
  'bye',
  'okay'
])

/** Hesitations and backchannel sounds with no content: um, uhh, hmm, mhm, mm-hmm, uh-huh, ah, oh, er. */
const FILLER = /^(?:u+[hm]+|h+m+|m+h?m+|e+r+m*|a+h+|o+h+|uhhuh|huh|eh)$/

/** `language`: the setting, or else the language the call has been in so far (see `callLanguage`). */
export async function transcribe(
  ai: Llm,
  model: string,
  pcm: Int16Array,
  language: string
): Promise<string> {
  const lang = language
    ? ` The speech is most likely in ${language}; write another language only if the speech clearly switches to it.`
    : ''
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
          ' If there is no clear human speech (only silence, typing, clicks, breathing, music, background noise or' +
          ' an unclear murmur), output exactly NO_SPEECH. Never describe sounds or output tags like <noise>.'
      }
    ]
  })
  return cleanTranscript(text, rms(pcm))
}

/** The language of the recent transcript, by script: a hint so noise and short words are not heard as another
 *  language. Not the lines themselves: given earlier lines, the STT model copies them into its output. */
export function callLanguage(texts: string[]): string {
  const letters = texts.join(' ').match(/\p{L}/gu) ?? []
  if (letters.length < 20) return ''
  const share = (re: RegExp): number => letters.filter((c) => re.test(c)).length / letters.length
  if (share(/\p{Script=Latin}/u) >= 0.8) return 'English (it may mix in Hindi words)'
  if (share(/\p{Script=Devanagari}/u) >= 0.8) return 'Hindi'
  return ''
}

/** Drop empty output, sound tags, pure filler ("um", "mhm") and the usual hallucinations on near-silent audio. */
export function cleanTranscript(text: string, level: number): string {
  const t = text
    .replace(/<[^>]*>|\[[^\]]*\]/g, ' ') // "<noise>", "[inaudible]"
    .trim()
    .replace(/^["'“]|["'”]$/g, '')
    .trim()
  if (/^[\s\p{P}]*$/u.test(t) || /NO_SPEECH|^no speech\W*$/i.test(t)) return ''
  if (/^\(.*\)$/.test(t)) return '' // "(no speech)"
  if (/^\d{1,2}[:.]\d{2}$|^0+$/.test(t)) return '' // "00:00": a timestamp, not speech
  const norm = t
    .toLowerCase()
    .replace(/[^\p{L}\s]/gu, '')
    .trim()
  if (norm.split(/\s+/).every((w) => FILLER.test(w))) return ''
  if (level < 400 && HALLUCINATIONS.has(norm)) return ''
  return t.replace(/\s{2,}/g, ' ')
}
