// Scores a replay against gold.json: decision metrics (no model) and card quality (an LLM judge with a fixed prompt).
import type { Brief } from '../../src/shared/types'
import { generateText, type Llm } from '../../src/main/llm'
import { mmss, parseJson, pool, segments, type CallFile, type GoldMoment } from './timeline'
import type { Decision } from './run'

export const JUDGE_MODEL = 'gemini-4-hydrogen'
const CRITERIA = ['asked', 'speakable', 'technical', 'grounded', 'fresh'] as const
type Scores = Record<(typeof CRITERIA)[number], number> & { why: string }

// Fixed across iterations: change it only together with a new baseline.
const JUDGE = `You grade one card from a live call assistant. The user is on a call; when the other person stops talking,
the assistant shows a card: a "say" line the user can speak right away, then talking points. Grade 1 (bad) to 5 (excellent):
- asked: answers what the other person actually asked or challenged at this moment (a pushback needs a concede-or-defend
  and a pivot; a task statement needs the task restated and a structure to start; "any questions?" needs sharp
  questions grounded in what they said earlier).
- speakable: the say line works on its own and can be spoken as is: plain, natural spoken English (the user speaks plain
  Indian English), at most 22 words, no fancy vocabulary, no corporate phrasing.
- technical: correct and specific technically (for non-technical questions: concrete and sensible).
- grounded: facts about the user come only from the profile, the brief or what the user said in the call. Invented facts
  score 1. A [blank] where the profile had the fact counts against it.
- fresh: does not repeat what the user already said; builds on it.
Use the reference (what a strong card would contain, and what the user actually answered) to judge, not to demand the
same words. JSON only: {"asked":n,"speakable":n,"technical":n,"grounded":n,"fresh":n,"why":"one short sentence"}`

export interface ScoreInput {
  call: CallFile
  gold: GoldMoment[]
  decisions: Decision[]
  from: number
  to: number
  profile: string
  brief: Brief
  llm: Llm
  judge: boolean
}

const directive = (raw = ''): string => /@(none|new|extend)/i.exec(raw)?.[1].toLowerCase() ?? '-'
const shown = (d?: Decision): boolean => d?.run.outcome === 'new' || d?.run.outcome === 'extend'
const pct = (a: number, b: number): string =>
  b ? `${((100 * a) / b).toFixed(0)}% (${a}/${b})` : '-'
const cell = (s = ''): string => s.replace(/\s+/g, ' ').replace(/\|/g, '/').trim()
const avg = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN)

export interface ScoreResult {
  metrics: Record<string, unknown>
  headline: string
  markdown: string
  moments: unknown[]
  decisions: Decision[]
}

export async function score(x: ScoreInput): Promise<ScoreResult> {
  const segs = segments(x.call).filter((g) => g.speaker === 'them')
  const uttOf = new Map(segs.map((g) => [g.end, g.utt]))
  const moments = x.gold.filter((m) => m.t >= x.from && m.t <= x.to)
  const at = new Map<number, Decision>()
  for (const d of x.decisions) if (d.run.kind === 'auto') at.set(Math.round(d.t * 100), d)
  const dec = (m: GoldMoment): Decision | undefined => at.get(Math.round(m.t * 100))

  // decisions
  const cues = moments.filter((m) => m.label === 'cue')
  const nones = moments.filter((m) => m.label === 'none')
  const hit = (m: GoldMoment): boolean =>
    shown(dec(m)) ||
    moments.some(
      (o) =>
        o.label === 'optional' &&
        o.t < m.t &&
        m.t - o.t < 30 &&
        uttOf.get(o.t) === uttOf.get(m.t) &&
        shown(dec(o))
    )
  const hits = cues.filter(hit)
  const falseCues = nones.filter((m) => shown(dec(m)))
  const handover = nones.filter((m) => segs.find((g) => g.end === m.t)?.last)
  const kinds = cues.filter((m) => shown(dec(m)))
  const kindOk = kinds.filter((m) => directive(dec(m)!.run.raw) === m.kind)
  const perCard = new Map<string, number>()
  for (const d of x.decisions)
    if (shown(d) && d.run.cardId) perCard.set(d.run.cardId, (perCard.get(d.run.cardId) ?? 0) + 1)
  const cards = [...perCard.keys()]
  const sections = [...perCard.values()]
  const lat = x.decisions
    .filter((d) => shown(d) && d.run.firstLineAt && d.run.speechEndAt)
    .map((d) => (d.run.firstLineAt! - d.run.speechEndAt!) / 1000)
    .sort((a, b) => a - b)
  const minutes = (x.to - x.from) / 60
  // generation speed of shown cards: whole reply time, and output tokens/s (estimated as characters / 4)
  const gen = x.decisions.filter(
    (d) => shown(d) && d.run.endedAt && d.run.firstChunkAt && d.run.raw
  )
  const median = (xs: number[]): number | null =>
    xs.length ? +[...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)].toFixed(2) : null
  const totalS = median(gen.map((d) => (d.run.endedAt! - d.run.startedAt) / 1000))
  const tokensPerS = median(
    gen
      .filter((d) => d.run.endedAt! - d.run.firstChunkAt! > 100)
      .map((d) => d.run.raw!.length / 4 / ((d.run.endedAt! - d.run.firstChunkAt!) / 1000))
  )

  // card quality
  const toJudge = moments.filter((m) => m.label !== 'none' && dec(m)?.section)
  const judged = new Map<GoldMoment, Scores>()
  if (x.judge)
    await pool(toJudge, 6, async (m) => {
      const s = dec(m)!.section!
      const before = x.call.utterances
        .filter((u) => u.start < m.t && u.end > m.t - 240)
        .map(
          (u) =>
            `${u.speaker === 'you' ? 'You' : 'Them'}: ${u.words
              .filter((w) => w[2] <= m.t + 0.01)
              .map((w) => w[0])
              .join(' ')}`
        )
        .join('\n')
        .slice(-4000)
      const card = `They asked: ${s.prompt}\n> ${s.say}\n${s.points.map((p) => `- ${p.text}`).join('\n')}${s.detail ? `\n## ${s.detail}` : ''}`
      try {
        const r = await generateText(x.llm, {
          model: JUDGE_MODEL,
          json: true,
          parts: [
            {
              text: `${JUDGE}\n\nPROFILE OF THE USER\n${x.profile || '(empty)'}\n\nTHE CALL\n${x.brief.title}\n${(x.brief.details ?? []).map((d) => `${d.label}: ${d.value}`).join('\n')}\n\nTRANSCRIPT UP TO THIS MOMENT (last few minutes)\n${before}\n\nREFERENCE\nA strong card: ${m.note ?? '(optional moment: a short, useful card)'}\nWhat the user actually said next: ${m.answer ?? '(not recorded)'}\n\nTHE CARD\n${card}`
            }
          ]
        })
        judged.set(m, parseJson<Scores>(r))
      } catch (e) {
        console.log(`  judge failed at ${mmss(m.t)}: ${e}`)
      }
    })
  const quality = Object.fromEntries(
    CRITERIA.map((c) => [c, +avg([...judged.values()].map((s) => s[c])).toFixed(2)])
  ) as Record<(typeof CRITERIA)[number], number>
  const overall = +avg(Object.values(quality)).toFixed(2)
  const sayWords = toJudge.map((m) => dec(m)!.section!.say.split(/\s+/).filter(Boolean).length)

  const metrics = {
    moments: moments.length,
    cueRecall: hits.length / (cues.length || 1),
    falseCueRate: falseCues.length / (nones.length || 1),
    falseCuesAtHandover: handover.filter((m) => shown(dec(m))).length,
    falseCuesMidTurn: falseCues.length - handover.filter((m) => shown(dec(m))).length,
    optionalCards: moments.filter((m) => m.label === 'optional' && shown(dec(m))).length,
    newExtendAccuracy: kindOk.length / (kinds.length || 1),
    cards: cards.length,
    maxSections: Math.max(0, ...sections),
    meanSections: +avg(sections).toFixed(2),
    cardsPerMinute: +(cards.length / minutes).toFixed(2),
    cancelled: x.decisions.filter((d) => d.run.outcome === 'cancelled').length,
    errors: x.decisions.filter((d) => d.run.outcome === 'error').length,
    latencyMedianS: lat.length ? +lat[Math.floor(lat.length / 2)].toFixed(2) : null,
    latencyP90S: lat.length ? +lat[Math.floor(lat.length * 0.9)].toFixed(2) : null,
    replyTotalMedianS: totalS,
    tokensPerS,
    sayOver22Words: sayWords.filter((n) => n > 22).length,
    judged: judged.size,
    quality,
    overall
  }

  const headline = `recall ${pct(hits.length, cues.length)} · false cues ${pct(falseCues.length, nones.length)} · new/extend ${pct(kindOk.length, kinds.length)} · cards ${cards.length} (max ${metrics.maxSections} sections, mean ${metrics.meanSections}) · quality ${overall} ${JSON.stringify(quality)} · latency median ${metrics.latencyMedianS}s`

  const rows = moments
    .filter((m) => m.label !== 'none' || shown(dec(m)) || segs.find((g) => g.end === m.t)?.last)
    .map((m) => {
      const d = dec(m)
      const s = d?.section
      const j = judged.get(m)
      const outcome = d ? `${d.run.outcome}${d.run.reason ? ` (${d.run.reason})` : ''}` : 'no run'
      const verdict =
        m.label === 'cue'
          ? hit(m)
            ? 'ok'
            : '**MISS**'
          : m.label === 'none' && shown(d)
            ? '**FALSE**'
            : ''
      const card = s
        ? `${d!.sectionsOnCard}§ *${cell(s.prompt)}* > ${cell(s.say)} ${s.points.map((p) => `· ${cell(p.text)}`).join(' ')}`
        : ''
      const sc = j ? `${CRITERIA.map((c) => j[c]).join('/')} ${cell(j.why)}` : ''
      return `| ${mmss(m.t)} | ${cell(m.said.slice(-110))} | ${m.label}${m.kind ? `/${m.kind}` : ''} ${verdict} | ${outcome} | ${card} | ${sc} |`
    })
  const markdown = `# Replay ${mmss(x.from)}–${mmss(x.to)}

${headline}

| metric | value |
| --- | --- |
${Object.entries(metrics)
  .filter(([k]) => k !== 'quality')
  .map(
    ([k, v]) =>
      `| ${k} | ${typeof v === 'number' && k.endsWith('Rate') ? (100 * v).toFixed(1) + '%' : typeof v === 'number' && /Recall|Accuracy/.test(k) ? (100 * v).toFixed(1) + '%' : v} |`
  )
  .join('\n')}
| quality (asked/speakable/technical/grounded/fresh) | ${CRITERIA.map((c) => quality[c]).join(' / ')} |

Rows: every cue/optional moment, every handover (they stop and the user speaks next), and every card shown.
Scores: ${CRITERIA.join('/')}.

| time | they said | gold | decision | card | scores |
| --- | --- | --- | --- | --- | --- |
${rows.join('\n')}
`
  return {
    metrics,
    headline,
    markdown,
    moments: moments.map((m) => ({
      ...m,
      decision: dec(m)?.run.outcome,
      directive: directive(dec(m)?.run.raw),
      section: dec(m)?.section,
      scores: judged.get(m)
    })),
    decisions: x.decisions
  }
}
