// Turns a recording folder (turns.json + optional call.wav) into call.json with corrected speakers, and you.pcm /
// them.pcm (call.wav masked by speaker) for SIDEKICK_FAKE_AUDIO. Usage: npm run replay:prepare -- <dir>
// 1. Acoustic tags: a nearest-centroid classifier on each voice's spectral envelope (mic, room, timbre), trained on the
//    transcript's own labels, tags every 6 words with the voice it hears.
// 2. A strong model re-labels the words from meaning plus those tags (transcripts often put a question inside the
//    other's turn, or start a turn with the other person's words).
// 3. Checks: acoustic agreement over the whole call, and the model listens to 12 speaker changes (plus 12 controls).
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import type { Part } from '@google/genai'
import type { Speaker } from '../../src/shared/types'
import { loadEnvLocal } from '../../src/main/env'
import { audioPart, generateText, makeLlm } from '../../src/main/llm'
import { defaultSettings } from '../../src/main/settings'
import { SAMPLE_RATE, pcmToWav, wavToPcm } from '../../src/main/audio/wav'
import { mmss, parseJson, pool, type CallFile, type CallUtterance, type Word } from './timeline'

const MODEL = process.env.REPLAY_MODEL ?? 'gemini-4-hydrogen'
const WIN = 400 // words per labelling window
const CTX = 60 // context words shown on each side

interface W {
  w: string
  s: number
  e: number
  label: Speaker // the transcript tool's label
  who: Speaker // corrected
  sure: boolean
}

const dir = resolve(process.argv[2] ?? '')
loadEnvLocal(resolve(__dirname, '../..'))
const llm = makeLlm(defaultSettings(process.env).vertex)
const ask = (parts: Part[]): Promise<string> =>
  generateText(llm, { model: MODEL, parts, json: true, maxTokens: 8000 })

async function label(words: W[], tags: Map<number, string>): Promise<void> {
  const starts = new Set<number>()
  words.forEach((w, i) => i && words[i - 1].label !== w.label && starts.add(i))
  const wins = Array.from({ length: Math.ceil(words.length / WIN) }, (_, k) => k * WIN)
  await pool(wins, 6, async (a) => {
    const b = Math.min(words.length, a + WIN) - 1
    const lo = Math.max(0, a - CTX)
    const hi = Math.min(words.length - 1, b + CTX)
    const body = words
      .slice(lo, hi + 1)
      .map((w, k) => {
        const i = lo + k
        return `${i === lo || starts.has(i) ? `\n[turn: ${w.label}] ` : ''}${tags.get(i) ?? ''}${i}:${w.w}`
      })
      .join(' ')
    const prompt = `This is part of a transcript of a two-person call. "you" is the person who recorded it, "them" is the other person.
The transcription tool split the call into turns and labelled each turn, but its labels are coarse: a turn often contains
the other person's words too (a question asked in the middle of the other's answer, a short "yeah" or "right", the first
words of the next turn, or the two talking over each other). Most labels are right, so use them to learn who is who.
Words are numbered; "[turn: x]" marks where the tool started a turn and whom it credited.${
      tags.size
        ? `
{Y} / {T}: a voice detector says the following words sound like "you" / "them"; lowercase {y} / {t} = weak, {?} = too
short. It is right about 95% of the time; it errs on very short stretches and when both talk at once. When meaning and
voice agree, follow them; a run of several tags against the turn label is strong evidence of the other speaker.`
        : ''
    }

Decide who actually says each word from word ${a} to word ${b} (words outside that range are context). Use meaning
(who asks and who answers, who talks about "our company" or "your profile", replies to what was just said, sentence
breaks) and the voice tags.
Output JSON only: {"segments":[{"from":<first word number>,"speaker":"you"|"them","sure":true|false}]}
Segments in order, the first starts at word ${a}, a new segment only where the speaker changes; "sure": false when you cannot tell.

TRANSCRIPT
${body}`
    const r = parseJson<{ segments: { from: number; speaker: Speaker; sure: boolean }[] }>(
      await ask([{ text: prompt }])
    )
    const segs = r.segments
      .filter((s) => s.from >= a && s.from <= b)
      .sort((x, y) => x.from - y.from)
    if (!segs.length || segs[0].from !== a)
      segs.unshift({ from: a, speaker: words[a].label, sure: false })
    segs.forEach((s, k) => {
      const end = k + 1 < segs.length ? segs[k + 1].from : b + 1
      for (let i = s.from; i < end; i++) {
        words[i].who = s.speaker === 'you' || s.speaker === 'them' ? s.speaker : words[i].label
        words[i].sure = s.sure !== false
      }
    })
    process.stdout.write('.')
  })
  console.log()
}

/** Maximal runs of consecutive words with the same corrected speaker and the same `key`. */
function runs<K>(words: W[], key: (w: W) => K): { a: number; b: number; k: K }[] {
  const out: { a: number; b: number; k: K }[] = []
  words.forEach((w, i) => {
    const last = out[out.length - 1]
    if (last && words[last.b].who === w.who && last.k === key(w)) last.b = i
    else out.push({ a: i, b: i, k: key(w) })
  })
  return out
}

let pcm: Int16Array | null = null
const clip = (s: number, e: number): Int16Array =>
  pcm!.subarray(Math.max(0, Math.round(s * SAMPLE_RATE)), Math.round(e * SAMPLE_RATE))

// ---- acoustic check: each voice has its own spectral envelope (mic, room, codec, timbre) ----
const N = 512
const EDGES = [...new Set(Array.from({ length: 33 }, (_, i) => Math.round(4 * 64 ** (i / 32))))]

/** In-place radix-2 FFT; returns the power spectrum of the first N/2 + 1 bins. */
function power(frame: Float64Array): Float64Array {
  const re = Float64Array.from(
    frame,
    (v, i) => v * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1)))
  )
  const im = new Float64Array(N)
  for (let i = 1, j = 0; i < N; i++) {
    let bit = N >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) [re[i], re[j], im[i], im[j]] = [re[j], re[i], im[j], im[i]]
  }
  for (let len = 2; len <= N; len <<= 1) {
    const ang = (-2 * Math.PI) / len
    for (let i = 0; i < N; i += len)
      for (let k = 0; k < len / 2; k++) {
        const wr = Math.cos(ang * k)
        const wi = Math.sin(ang * k)
        const a = i + k
        const b = a + len / 2
        const xr = re[b] * wr - im[b] * wi
        const xi = re[b] * wi + im[b] * wr
        re[b] = re[a] - xr
        im[b] = im[a] - xi
        re[a] += xr
        im[a] += xi
      }
  }
  return Float64Array.from({ length: N / 2 + 1 }, (_, k) => re[k] ** 2 + im[k] ** 2)
}

/** Mean log band-energy profile (level removed) over the louder half of the frames; null if too short. */
function voiceprint(s: number, e: number): number[] | null {
  const x = clip(s, e)
  const frames: Float64Array[] = []
  for (let a = 0; a + N <= x.length; a += 256) frames.push(Float64Array.from(x.subarray(a, a + N)))
  if (frames.length < 4) return null
  const energy = frames.map((f) => f.reduce((t, v) => t + v * v, 0))
  const median = [...energy].sort((p, q) => p - q)[Math.floor(energy.length / 2)]
  const loud = frames.filter((_, i) => energy[i] >= median)
  const out = new Array(EDGES.length - 1).fill(0)
  for (const f of loud) {
    const p = power(f)
    const bands = EDGES.slice(1).map((hi, i) =>
      Math.log(p.slice(EDGES[i], hi).reduce((t, v) => t + v, 0) + 1e-3)
    )
    const mean = bands.reduce((t, v) => t + v, 0) / bands.length
    bands.forEach((v, i) => (out[i] += (v - mean) / loud.length))
  }
  return out
}

/** Nearest-centroid speaker classifier trained on 25-word stretches of the current labels. */
function trainVoices(
  words: W[]
): (s: number, e: number) => { who: Speaker; margin: number } | null {
  const train: { sp: Speaker; f: number[] }[] = []
  for (const r of runs(words, () => true)) {
    for (let i = r.a; i + 25 <= r.b + 1; i += 25) {
      const f = voiceprint(words[i].s, words[i + 24].e)
      if (f) train.push({ sp: words[i].who, f })
    }
  }
  const dims = train[0].f.length
  const mu = Array.from(
    { length: dims },
    (_, d) => train.reduce((t, x) => t + x.f[d], 0) / train.length
  )
  const sd = Array.from({ length: dims }, (_, d) =>
    Math.sqrt(train.reduce((t, x) => t + (x.f[d] - mu[d]) ** 2, 0) / train.length)
  )
  const z = (f: number[]): number[] => f.map((v, d) => (v - mu[d]) / sd[d])
  const centroid = (sp: Speaker): number[] => {
    const xs = train.filter((x) => x.sp === sp).map((x) => z(x.f))
    return Array.from({ length: dims }, (_, d) => xs.reduce((t, x) => t + x[d], 0) / xs.length)
  }
  const c = { you: centroid('you'), them: centroid('them') }
  const dist = (a: number[], b: number[]): number =>
    Math.sqrt(a.reduce((t, v, d) => t + (v - b[d]) ** 2, 0))
  return (s, e) => {
    const f = voiceprint(s - 0.1, e + 0.1)
    if (!f) return null
    const dy = dist(z(f), c.you)
    const dt = dist(z(f), c.them)
    return { who: dy < dt ? 'you' : 'them', margin: Math.abs(dy - dt) / Math.min(dy, dt) }
  }
}

/** Model listening: does the voice change at the mark? (within one clip, which models judge far better than across clips) */
async function heardChange(before: Word[], after: Word[]): Promise<boolean> {
  const wav = pcmToWav(clip(before[0][1] - 0.2, after[after.length - 1][2] + 0.2))
  const r = parseJson<{ different: boolean }>(
    await ask([
      audioPart(wav),
      {
        text: `This audio clip has these words: "${before.map((w) => w[0]).join(' ')} ‖ ${after.map((w) => w[0]).join(' ')}".
Listen to the voices. Is the voice after the ‖ mark a different person from the voice before it? Judge by voice (pitch,
timbre, recording quality), not by content. JSON only: {"different": true|false}`
      }
    ])
  )
  return r.different === true
}

const text = (words: W[], a: number, b: number): string =>
  words
    .slice(a, b + 1)
    .map((w) => w.w)
    .join(' ')

async function main(): Promise<void> {
  const turns = JSON.parse(readFileSync(join(dir, 'turns.json'), 'utf8')).turns as {
    speaker: Speaker
    words: Word[]
  }[]
  const words: W[] = turns.flatMap((t) =>
    t.words.map(([w, s, e]) => ({ w, s, e, label: t.speaker, who: t.speaker, sure: true }))
  )
  const wav = join(dir, 'call.wav')
  const tags = new Map<number, string>()
  if (existsSync(wav)) {
    pcm = wavToPcm(readFileSync(wav))
    const classify = trainVoices(words)
    for (const r of runs(words, () => true))
      for (let i = r.a; i <= r.b; i += 6) {
        const v = classify(words[i].s, words[Math.min(r.b, i + 5)].e)
        const t = !v ? '?' : v.who === 'you' ? 'Y' : 'T'
        tags.set(i, `{${v && v.margin < 0.15 ? t.toLowerCase() : t}} `)
      }
  }
  console.log(
    `${words.length} words in ${turns.length} turns; labelling with ${MODEL}${tags.size ? ' (text + voice tags)' : ' (text only)'}`
  )
  await label(words, tags)
  for (const r of runs(words, (w) => w.who !== w.label).filter((r) => r.k))
    console.log(
      `  ${mmss(words[r.a].s)} ${words[r.a].label}→${words[r.a].who}: ${text(words, r.a, r.b).slice(0, 100)}`
    )
  console.log(
    `${words.filter((w) => w.who !== w.label).length} words change speaker, ${words.filter((w) => !w.sure).length} unsure`
  )

  // utterances: consecutive words of one speaker
  const utterances: CallUtterance[] = []
  for (const w of words) {
    const u = utterances[utterances.length - 1]
    if (u && u.speaker === w.who) u.words.push([w.w, w.s, w.e])
    else utterances.push({ speaker: w.who, start: 0, end: 0, text: '', words: [[w.w, w.s, w.e]] })
  }
  for (const u of utterances) {
    u.start = u.words[0][1]
    u.end = u.words[u.words.length - 1][2]
    u.text = u.words.map((w) => w[0]).join(' ')
  }
  const duration = pcm ? pcm.length / SAMPLE_RATE : words[words.length - 1].e
  const call: CallFile = { duration, utterances }
  writeFileSync(join(dir, 'call.json'), JSON.stringify(call, null, 1))
  console.log(`call.json: ${utterances.length} utterances (was ${turns.length} turns)`)

  if (pcm) {
    // independent estimate: the acoustic classifier on every 8-word window of the final labels
    const classify = trainVoices(words)
    let agree = 0
    let total = 0
    for (const u of utterances)
      for (let i = 0; i < u.words.length; i += 8) {
        const ws = u.words.slice(i, i + 8)
        const v = classify(ws[0][1], ws[ws.length - 1][2])
        if (!v) continue
        total++
        if (v.who === u.speaker) agree++
        else if (v.margin > 0.3)
          console.log(
            `  acoustic disagrees ${mmss(ws[0][1])} (${u.speaker}): ${ws.map((w) => w[0]).join(' ')}`
          )
      }
    console.log(
      `acoustic agreement: ${agree}/${total} 8-word windows (${((100 * agree) / total).toFixed(1)}%)`
    )

    // spot check by model listening: 12 speaker changes, and 12 mid-turn pauses as a control
    const changes = utterances
      .slice(1)
      .map((u, i) => [utterances[i].words.slice(-6), u.words.slice(0, 6)])
    const pick = changes
      .filter((_, i) => i % Math.max(1, Math.floor(changes.length / 12)) === 0)
      .slice(0, 12)
    const long = utterances.filter((u) => u.words.length > 40)
    const ctrl = long
      .filter((_, i) => i % Math.max(1, Math.floor(long.length / 12)) === 0)
      .slice(0, 12)
      .map((u) => [u.words.slice(20, 26), u.words.slice(26, 32)])
    const hc = await pool(pick, 6, ([a, b]) => heardChange(a, b))
    const hn = await pool(ctrl, 6, ([a, b]) => heardChange(a, b))
    pick.forEach(([a, b], i) =>
      console.log(
        `  ${hc[i] ? 'ok ' : 'MISS'} change at ${mmss(b[0][1])}: …${a.map((w) => w[0]).join(' ')} ‖ ${b.map((w) => w[0]).join(' ')}…`
      )
    )
    console.log(
      `model listening: ${hc.filter(Boolean).length}/${pick.length} speaker changes heard; control: ${hn.filter((x) => !x).length}/${ctrl.length} mid-turn marks heard as the same voice`
    )

    // you.pcm / them.pcm: the call masked to each speaker's words (±250 ms), silence elsewhere
    const PAD = 0.25
    for (const sp of ['you', 'them'] as Speaker[]) {
      const out = new Int16Array(pcm.length)
      for (const u of utterances.filter((x) => x.speaker === sp))
        for (const [, s, e] of u.words) {
          const a = Math.max(0, Math.round((s - PAD) * SAMPLE_RATE))
          const b = Math.min(pcm.length, Math.round((e + PAD) * SAMPLE_RATE))
          out.set(pcm.subarray(a, b), a)
        }
      writeFileSync(join(dir, `${sp}.pcm`), Buffer.from(out.buffer))
    }
    console.log('wrote you.pcm / them.pcm (16 kHz mono PCM16, what SIDEKICK_FAKE_AUDIO plays)')
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
