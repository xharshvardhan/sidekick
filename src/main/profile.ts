// "About me" builder: turns a resume, a pasted bio or what the user said on a call into profile text.
// Pure prompt building plus one model call. No Electron imports.
import type { Part } from '@google/genai'
import type { Session } from '../shared/types'
import { generateText, type Llm } from './llm'

export const PROFILE_HEADINGS = [
  'Snapshot',
  'Experience',
  'Projects and stories',
  'Skills',
  'Motivation and preferences',
  'How I speak'
]

const MAX_SOURCE_CHARS = 60_000

/** The user's own words from a call: the profile may only learn from the "you" side. */
export function sessionSelfText(s: Pick<Session, 'title' | 'utterances'>): string {
  const lines = s.utterances.filter((u) => u.speaker === 'you').map((u) => u.text.trim())
  return lines.length ? `What the user said on a call (${s.title}):\n${lines.join('\n')}` : ''
}

export function profileInstructions(current: string): string {
  return `You write the "About me" profile that a live-call copilot uses to answer questions in the user's voice.
Merge the CURRENT PROFILE with the NEW SOURCE and return the updated profile as plain text (no markdown symbols
except "- " bullets), under exactly these headings, in this order, each on its own line:
${PROFILE_HEADINGS.map((h) => `${h}`).join('\n')}

What goes under each heading:
- Snapshot: current role, years of experience, location, in two lines.
- Experience: per job, the company, dates, what they built, and the exact numbers.
- Projects and stories: 5 to 8 items, each usable for a behavioural or deep-dive question: situation, what I did, result.
- Skills: tools, languages, domains.
- Motivation and preferences: why they are moving and what they want; notice period or salary only if stated.
- How I speak: a few notes on tone and phrasing, only if the source is a transcript of them speaking; otherwise keep what the current profile says.

Hard rules:
- Use only facts present in the current profile or the new source. Never invent anything. Keep exact numbers as written.
- If something is uncertain, unclear or contradicts the current profile, keep it and mark it "(check)".
- Keep everything from the current profile that is still true; add or sharpen with the new source; drop duplicates.
- A heading with nothing known says "Nothing yet."
- About 700 words at most. Be dense, no filler.
- Return only the profile text.

CURRENT PROFILE
${current.trim() || '(empty)'}`
}

/** Merge a new source into the profile. `source` is the text and/or file parts to learn from. */
export async function draftProfile(
  ai: Llm,
  model: string,
  current: string,
  source: Part[]
): Promise<string> {
  const parts = source.map((p) =>
    p.text && p.text.length > MAX_SOURCE_CHARS ? { text: p.text.slice(0, MAX_SOURCE_CHARS) } : p
  )
  const text = await generateText(ai, {
    model,
    maxTokens: 4000,
    system: profileInstructions(current),
    parts: [{ text: 'NEW SOURCE' }, ...parts]
  })
  const out = text.replace(/^```\w*\n?|```\s*$/g, '').trim()
  if (!out) throw new Error('The model returned nothing. Try again.')
  return out
}
