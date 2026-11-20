// Drafts gold.json for a prepared call: every point where "them" stops talking (as the live segmenter cuts it) gets a
// label from a strong model. The draft must then be reviewed by a person. Usage: npm run replay:gold -- <dir>
import { existsSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import { loadEnvLocal } from '../../src/main/env'
import { generateText, makeLlm } from '../../src/main/llm'
import { defaultSettings } from '../../src/main/settings'
import { loadCall, mmss, parseJson, pool, segments, type GoldMoment } from './timeline'

const MODEL = process.env.REPLAY_MODEL ?? 'gemini-4-hydrogen'
const BATCH = 60

const RULES = `You are labelling a recorded call to test a live assistant. The assistant watches the call and, each time
"Them" stops talking, decides whether to show "You" (the user) a card with what to say. Each point where Them stopped
is marked ⟦M<n>⟧ in the transcript. Label each marked moment:
- "cue": the user needs help now: Them asked a question, challenged or pushed back on what the user said, stated an
  exercise or task, or invited the user to ask questions. Put "cue" on the moment where the ask is complete and Them
  hands over (usually the last mark before the user replies).
- "optional": a card would be acceptable but is not needed: the ask is already complete but Them keeps talking after the
  mark (clarifying, adding detail), or Them just finished a long answer to the user's own question (a follow-up
  question could help), or a rhetorical question.
- "none": nothing to help with: backchannels ("Got it", "Yep", "Makes sense"), small talk, Them mid-thought (the
  sentence or question is unfinished at the mark), Them explaining or describing (a company overview, a story) with no
  ask yet, Them answering the user's question.
For "cue" moments also give:
- "kind": "extend" only when it is a direct follow-up or pushback on the previous cue's question (same question, digging
  deeper or challenging the answer to it); otherwise "new" (a new question area, even about the same project).
- "note": one line: what a strong card would contain (the answer's core, structure, or the right technical point).
- "answer": one line: what the user actually said next (summary).`

async function main(): Promise<void> {
  const dir = resolve(process.argv[2] ?? '')
  const out = join(dir, 'gold.json')
  if (existsSync(out) && !process.argv.includes('--force'))
    throw new Error(`${out} exists (reviewed labels?); pass --force to overwrite`)
  loadEnvLocal(resolve(__dirname, '../..'))
  const llm = makeLlm(defaultSettings(process.env).vertex)
  const call = loadCall(dir)
  const segs = segments(call)

  // the transcript with each of their stops marked
  const moments: GoldMoment[] = []
  let text = ''
  let prevUtt = -1
  for (const g of segs) {
    if (g.utt !== prevUtt) text += `\n[${mmss(g.start)}] ${g.speaker === 'you' ? 'You' : 'Them'}: `
    prevUtt = g.utt
    text += g.text + ' '
    if (g.speaker === 'them') {
      text += `⟦M${moments.length}⟧ `
      moments.push({ t: g.end, said: g.text, label: 'none' })
    }
  }

  const batches = Array.from({ length: Math.ceil(moments.length / BATCH) }, (_, k) => k * BATCH)
  await pool(batches, 4, async (a) => {
    const b = Math.min(moments.length, a + BATCH) - 1
    const reply = await generateText(llm, {
      model: MODEL,
      json: true,
      maxTokens: 16000,
      parts: [
        {
          text: `${RULES}\n\nTRANSCRIPT\n${text}\n\nLabel moments M${a} to M${b}. JSON only:
{"moments":[{"id":<n>,"label":"cue"|"optional"|"none","kind":"new"|"extend","note":"...","answer":"..."}]}
(kind, note and answer only for cue moments).`
        }
      ]
    })
    for (const m of parseJson<{ moments: (Partial<GoldMoment> & { id: number })[] }>(reply)
      .moments) {
      const g = moments[m.id]
      if (!g || m.id < a || m.id > b) continue
      g.label = m.label === 'cue' || m.label === 'optional' ? m.label : 'none'
      if (g.label === 'cue')
        Object.assign(g, {
          kind: m.kind === 'extend' ? 'extend' : 'new',
          note: m.note,
          answer: m.answer
        })
    }
    process.stdout.write('.')
  })
  writeFileSync(out, JSON.stringify(moments, null, 1))
  const n = (l: string): number => moments.filter((m) => m.label === l).length
  console.log(
    `\n${moments.length} moments: ${n('cue')} cue, ${n('optional')} optional, ${n('none')} none → ${out}`
  )
  console.log('Review every label before using it.')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
