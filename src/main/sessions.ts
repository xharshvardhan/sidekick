// Sessions as JSON files in <userData>/sessions, plus the post-call recap. No Electron imports.
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'fs'
import { join } from 'path'
import type { Recap, Session, SessionMeta } from '../shared/types'
import { generateText, type Llm } from './llm'
import { transcriptText } from './director/prompt'

export class SessionStore {
  constructor(private dir: string) {
    mkdirSync(dir, { recursive: true })
  }

  private file(id: string): string {
    return join(this.dir, `${id.replace(/[^\w-]/g, '')}.json`)
  }

  save(s: Session): void {
    const f = this.file(s.id)
    writeFileSync(`${f}.tmp`, JSON.stringify(s))
    renameSync(`${f}.tmp`, f)
  }

  get(id: string): Session | null {
    const f = this.file(id)
    if (!existsSync(f)) return null
    try {
      return JSON.parse(readFileSync(f, 'utf8')) as Session
    } catch {
      return null
    }
  }

  list(): SessionMeta[] {
    const out: SessionMeta[] = []
    for (const name of readdirSync(this.dir)) {
      if (!name.endsWith('.json')) continue
      const s = this.get(name.slice(0, -5))
      if (!s) continue
      const { id, title, preset, startedAt, endedAt, utteranceCount, cardCount } = s
      out.push({ id, title, preset, startedAt, endedAt, utteranceCount, cardCount })
    }
    return out.sort((a, b) => b.startedAt - a.startedAt)
  }

  delete(id: string): void {
    rmSync(this.file(id), { force: true })
  }
}

export async function generateRecap(ai: Llm, model: string, s: Session): Promise<Recap> {
  const cards = s.cards.flatMap((c) => c.sections.map((x) => `- ${x.prompt}: ${x.say}`)).join('\n')
  const text = await generateText(ai, {
    model,
    json: true,
    maxTokens: 3000,
    parts: [
      {
        text: `You write the recap of a call for the user ("You"). The other side is "Them".
Call: ${s.title} (${s.preset}). Notes from the user: ${s.brief.notes || '(none)'}

Earlier summary:
${s.summary || '(none)'}

Transcript:
${transcriptText(s.utterances) || '(empty)'}

Cards Sidekick showed the user:
${cards || '(none)'}

Return JSON: {"summary": markdown (5-10 bullet points: what was discussed, decisions, numbers, impressions),
"actionItems": [short imperative follow-ups for the user, with owners/dates if mentioned],
"questions": [{"asked": question they asked the user, "howItWent": one honest line on the user's answer and what to improve}]}.
Use only what is in the transcript; do not invent.`
      }
    ]
  })
  const j = JSON.parse(text.replace(/^```(json)?|```$/g, '').trim()) as Partial<Recap>
  return {
    summary: String(j.summary ?? ''),
    actionItems: Array.isArray(j.actionItems) ? j.actionItems.map(String) : [],
    questions: Array.isArray(j.questions)
      ? j.questions.map((q) => ({
          asked: String(q?.asked ?? ''),
          howItWent: String(q?.howItWent ?? '')
        }))
      : []
  }
}
