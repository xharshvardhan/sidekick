// Replays a recorded call through the real director in virtual time, then scores it against gold.json.
// Usage: npm run replay -- <dataDir> [--from mm:ss] [--to mm:ss] [--out name] [--no-judge] [--no-profile] [--cue-model id]
//        npm run replay -- <dataDir> --rescore <name>   (score a saved run again, e.g. after editing gold.json)
// Text path: each speech segment (cut like the live segmenter) lands as an utterance when it ends, so no STT or audio.
// The clock runs in real time while a model call is in flight and jumps over idle stretches, so cancellation
// ("they kept talking"), queueing ("the user is speaking") and latency behave as they would live.
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import type { Brief, Card, CardSection, LiveState } from '../../src/shared/types'
import { Conversation } from '../../src/main/convo'
import { Deck, type UserActivity } from '../../src/main/director/cards'
import { Director, type RunRecord } from '../../src/main/director/director'
import { idleState } from '../../src/main/engine'
import { loadEnvLocal } from '../../src/main/env'
import { makeLlm } from '../../src/main/llm'
import { defaultSettings } from '../../src/main/settings'
import { HANG_S, loadCall, parseMmss, segments, type GoldMoment, type Seg } from './timeline'
import { score } from './score'

export interface Decision {
  t: number // end of their speech, seconds
  run: RunRecord
  section?: CardSection // the section this run wrote, as it ended
  sectionsOnCard?: number // the section's position on its card (1 = the card's first)
}

const START_DELAY_S = 0.1 // the segmenter reports a start after 100 ms of speech
const TICK_MS = 250

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 ? process.argv[i + 1] : undefined
}
const flag = (name: string): boolean => process.argv.includes(`--${name}`)
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function main(): Promise<void> {
  const dir = resolve(process.argv[2] ?? '')
  loadEnvLocal(resolve(__dirname, '../..'))
  const call = loadCall(dir)
  const brief = JSON.parse(readFileSync(join(dir, 'brief.json'), 'utf8')) as Brief
  const profileFile = join(dir, 'profile.txt')
  const profile =
    !flag('no-profile') && existsSync(profileFile) ? readFileSync(profileFile, 'utf8') : ''
  const goldFile = join(dir, 'gold.json')
  const gold = existsSync(goldFile)
    ? (JSON.parse(readFileSync(goldFile, 'utf8')) as GoldMoment[])
    : []
  const rescore = arg('rescore')
  if (rescore) {
    const saved = JSON.parse(readFileSync(join(dir, `${rescore}.json`), 'utf8'))
    const llm = makeLlm(defaultSettings(process.env).vertex)
    const result = await score({
      ...saved.range,
      call,
      gold,
      decisions: saved.decisions,
      profile,
      brief,
      llm,
      judge: !flag('no-judge')
    })
    writeFileSync(join(dir, `${rescore}.json`), JSON.stringify({ ...saved, ...result }, null, 1))
    writeFileSync(join(dir, `${rescore}.md`), result.markdown)
    return console.log(result.headline)
  }
  const from = arg('from') ? parseMmss(arg('from')!) : 0
  const to = arg('to') ? parseMmss(arg('to')!) : call.duration
  const base = defaultSettings(process.env)
  const settings = {
    ...base,
    profile,
    models: { ...base.models, cue: arg('cue-model') ?? base.models.cue }
  }
  const llm = makeLlm(settings.vertex)

  // virtual clock: epoch ms = EPOCH + call seconds * 1000
  const EPOCH = Date.now()
  let off = 0
  const now = (): number => Date.now() + off
  const at = (t: number): number => EPOCH + t * 1000

  const state: LiveState = {
    ...idleState(),
    session: 'live',
    sessionId: 'replay',
    title: brief.title,
    startedAt: EPOCH
  }
  const convo = new Conversation(state.utterances)
  const deck = new Deck(state)
  let lastYouEnd = 0
  const activity = (): UserActivity => ({
    now: now(),
    youSpeaking: state.partial.you,
    lastYouSpeechAt: lastYouEnd
  })
  const runs: RunRecord[] = []
  const decisions: Decision[] = []
  const director = new Director({
    state,
    deck,
    llm: () => llm,
    settings: () => settings,
    context: () => ({ summary: convo.summary, tail: convo.tail(), audio: [] }),
    activity,
    changed: () => {},
    toast: (kind, text) => console.log(`  [toast ${kind}] ${text}`),
    onRun: (r) => runs.push(r),
    now
  })
  director.setBrief(brief, [])

  let folding: Promise<unknown> | null = null
  const fold = (): void => {
    if (folding) return
    folding = convo
      .maybeFold(llm, settings.models.cue, now())
      .catch((e) => console.log(`  [summary error] ${e}`))
      .finally(() => (folding = null))
  }
  let n = 0
  const addUtterance = (g: Seg): void => {
    convo.add({
      id: `u${n++}`,
      speaker: g.speaker,
      text: g.text,
      startedAt: at(g.start),
      endedAt: at(g.end)
    })
    if (g.speaker === 'you')
      deck.applyCoverage(state.utterances.filter((u) => u.speaker === 'you').slice(-20))
    fold()
  }

  const segs = segments(call)
  // the call before --from only builds context
  for (const g of segs.filter((g) => g.end + HANG_S < from)) addUtterance(g)
  if (folding) await folding

  type Ev = { t: number; end: boolean; g: Seg }
  const evs: Ev[] = segs
    .filter((g) => g.end + HANG_S >= from && g.start < to)
    .flatMap((g) => [
      { t: g.start + START_DELAY_S, end: false, g },
      { t: g.end + HANG_S, end: true, g }
    ])
    .sort((a, b) => a.t - b.t || Number(b.end) - Number(a.end))
  if (evs.length) off = at(evs[0].t) - Date.now()

  let lastTick = now()
  const advance = async (target: number): Promise<void> => {
    while (now() < target) {
      if (director.busy || folding) await sleep(5)
      else off += Math.min(target, lastTick + TICK_MS) - now() // idle: jump
      if (now() - lastTick >= TICK_MS || now() >= target) {
        deck.tick(activity())
        lastTick = now()
      }
    }
  }

  const t0 = Date.now()
  let last = -1
  for (const ev of evs) {
    await advance(at(ev.t))
    const { g } = ev
    if (!ev.end) {
      state.partial = { ...state.partial, [g.speaker]: true }
      if (g.speaker === 'them') director.onThemStart()
      continue
    }
    state.partial = { ...state.partial, [g.speaker]: false }
    if (g.speaker === 'you') lastYouEnd = now()
    addUtterance(g)
    if (g.speaker === 'them') {
      director.onThemEnd(at(g.start), at(g.end))
    }
    const pct = Math.floor((100 * (ev.t - from)) / (Math.min(to, call.duration) - from))
    if (pct >= last + 10) {
      last = pct
      process.stdout.write(`${pct}% `)
    }
  }
  // let the last generation finish
  while (director.busy) await sleep(20)
  console.log(
    `\nreplayed ${((Math.min(to, call.duration) - from) / 60).toFixed(1)} min in ${((Date.now() - t0) / 1000).toFixed(0)} s, ${runs.length} director runs`
  )

  const cardOf = (id?: string): Card | undefined => state.cards.find((c) => c.id === id)
  const secOf = new Map<string, CardSection>()
  // each new/extend run wrote the section that was newest on its card when it ran; match by say line
  for (const r of runs) {
    const t = r.speechEndAt !== undefined ? (r.speechEndAt - EPOCH) / 1000 : NaN
    const card = cardOf(r.cardId)
    const section = card?.sections.find((s) => s.say === r.say && !secOf.has(s.id))
    if (section) secOf.set(section.id, section)
    decisions.push({
      t,
      run: r,
      section,
      sectionsOnCard: card ? card.sections.indexOf(section!) + 1 : undefined
    })
  }

  const name = arg('out') ?? `replay-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '')}`
  const result = await score({
    call,
    gold,
    decisions,
    from,
    to: Math.min(to, call.duration),
    profile,
    brief,
    llm,
    judge: !flag('no-judge')
  })
  writeFileSync(
    join(dir, `${name}.json`),
    JSON.stringify(
      { range: { from, to: Math.min(to, call.duration) }, ...result, summary: convo.summary },
      null,
      1
    )
  )
  writeFileSync(join(dir, `${name}.md`), result.markdown)
  console.log(result.headline)
  console.log(`wrote ${join(dir, name)}.json / .md`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
