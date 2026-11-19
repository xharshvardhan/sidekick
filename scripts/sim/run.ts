// Headless call simulator: renders a scripted two-person call with macOS `say`, plays it through the real
// pipeline (segmenter → STT → director, real Vertex calls) in real time, prints a timeline with latencies,
// and checks each line's expectation. Usage: npm run sim [-- scripts/sim/interview.json ...]
import { execFileSync } from 'child_process'
import { createHash } from 'crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { basename, join, resolve } from 'path'
import type { SessionPreset } from '../../src/shared/types'
import { Engine } from '../../src/main/engine'
import type { RunRecord } from '../../src/main/director/director'
import { loadEnvLocal } from '../../src/main/env'
import { makeLlm } from '../../src/main/llm'
import { defaultSettings } from '../../src/main/settings'
import { SAMPLE_RATE, wavToPcm } from '../../src/main/audio/wav'

type Expect = 'card' | 'none' | 'extend'
interface Line {
  speaker: 'you' | 'them'
  text: string
  gapMs?: number // silence before this line starts (negative = overlap)
  expect?: Expect
}
interface Script {
  title: string
  preset: SessionPreset
  notes: string
  profile: string
  voices?: { you?: string; them?: string }
  lines: Line[]
}
interface Placed extends Line {
  start: number // ms on the call timeline
  end: number
  runs: RunRecord[]
}

const ROOT = resolve(__dirname, '../..')
const OUT = join(tmpdir(), 'sidekick-sim')
const ms = (n: number): number => Math.round((n * 1000) / SAMPLE_RATE)
const sec = (n: number): string => (n / 1000).toFixed(1).padStart(5)

function render(text: string, voice: string): Int16Array {
  const dir = join(OUT, 'cache')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, createHash('sha1').update(`${voice}\n${text}`).digest('hex') + '.wav')
  // -o renders to a file; nothing is played on the speakers
  if (!existsSync(file))
    execFileSync('say', ['-v', voice, '-o', file, '--data-format=LEI16@16000', text])
  return wavToPcm(readFileSync(file))
}

/** Lay the lines out on two timelines and write you.pcm / them.pcm. */
export function build(
  script: Script,
  name: string
): { dir: string; lines: Placed[]; totalMs: number } {
  const voices = { you: script.voices?.you ?? 'Daniel', them: script.voices?.them ?? 'Samantha' }
  let cursor = 1000
  const placed: Placed[] = []
  const clips: Int16Array[] = []
  for (const l of script.lines) {
    const pcm = render(l.text, voices[l.speaker])
    const start = Math.max(0, cursor + (l.gapMs ?? 700))
    const end = start + ms(pcm.length)
    placed.push({ ...l, start, end, runs: [] })
    clips.push(pcm)
    cursor = end
  }
  const totalMs = cursor + 4000
  const tracks = {
    you: new Int16Array((totalMs * SAMPLE_RATE) / 1000),
    them: new Int16Array((totalMs * SAMPLE_RATE) / 1000)
  }
  placed.forEach((p, i) => {
    const t = tracks[p.speaker]
    const at = (p.start * SAMPLE_RATE) / 1000
    for (let k = 0; k < clips[i].length && at + k < t.length; k++)
      t[at + k] = Math.max(-32768, Math.min(32767, t[at + k] + clips[i][k]))
  })
  const dir = join(OUT, name)
  mkdirSync(dir, { recursive: true })
  for (const sp of ['you', 'them'] as const)
    writeFileSync(join(dir, `${sp}.pcm`), Buffer.from(tracks[sp].buffer))
  // the app auto-starts a session with this brief when launched with SIDEKICK_FAKE_AUDIO=<dir>
  writeFileSync(
    join(dir, 'brief.json'),
    JSON.stringify({ title: script.title, preset: script.preset, notes: script.notes, files: [] })
  )
  return { dir, lines: placed, totalMs }
}

function judge(expect: Expect, runs: RunRecord[]): { got: string; ok: boolean } {
  const outs = runs.map((r) => r.outcome ?? '?')
  const got =
    outs.find((o) => o === 'new' || o === 'extend') ??
    outs.find((o) => o === 'none' || o === 'skipped') ??
    outs[outs.length - 1] ??
    'no run'
  if (expect === 'card') return { got, ok: got === 'new' || got === 'extend' }
  if (expect === 'extend') return { got, ok: got === 'extend' }
  return { got, ok: got !== 'new' && got !== 'extend' && got !== 'error' }
}

async function runScript(path: string): Promise<boolean> {
  const script = JSON.parse(readFileSync(path, 'utf8')) as Script
  const name = basename(path, '.json')
  const { dir, lines, totalMs } = build(script, name)
  console.log(
    `\n=== ${script.title}  (${name}, ${sec(totalMs).trim()} s of audio, fake audio dir: ${dir})`
  )

  // SIM_NO_PROFILE=1 checks grounding: with no profile the cards must not invent the user's experience
  const settings = {
    ...defaultSettings(process.env),
    profile: process.env.SIM_NO_PROFILE ? '' : script.profile
  }
  const llm = makeLlm(settings.vertex)
  const t0 = Date.now() + 300
  const runs: RunRecord[] = []
  const errors: string[] = []
  const engine = new Engine({
    llm: () => llm,
    settings: () => settings,
    bin: '',
    fakeDir: dir,
    fakeStartAt: t0,
    emitLive: () => {},
    emitLevels: () => {},
    toast: (kind, text) => {
      if (kind === 'error') errors.push(text)
      console.log(`  [toast ${kind}] ${text}`)
    },
    log: (m) => console.log(`  [log] ${m}`),
    onRun: (r) => runs.push(r)
  })
  engine.start({ title: script.title, preset: script.preset, notes: script.notes, files: [] })

  // play the whole call, then let in-flight work settle
  await new Promise((r) => setTimeout(r, t0 - Date.now() + totalMs + 2000))
  for (let i = 0; i < 30 && engine.state.thinking; i++) await new Promise((r) => setTimeout(r, 500))
  await new Promise((r) => setTimeout(r, 1500))
  engine.end()

  // attribute each auto run to the `them` line whose audio ended closest to the run's speech end
  const them = lines.filter((l) => l.speaker === 'them')
  for (const r of runs) {
    if (r.kind !== 'auto' || !r.speechEndAt) continue
    const at = r.speechEndAt - t0
    const best = them.reduce((a, b) => (Math.abs(b.end - at) < Math.abs(a.end - at) ? b : a))
    if (Math.abs(best.end - at) < 1500) best.runs.push(r)
  }

  let pass = true
  const fast: number[] = []
  for (const l of lines) {
    const tag = l.speaker === 'them' ? 'THEM' : ' you'
    let verdict = ''
    if (l.expect) {
      const j = judge(l.expect, l.runs)
      pass &&= j.ok
      verdict = `  expect ${l.expect.padEnd(6)} got ${j.got.padEnd(9)} ${j.ok ? 'PASS' : 'FAIL'}`
    }
    console.log(
      `${sec(l.start)}s ${tag}  ${JSON.stringify(l.text.length > 70 ? l.text.slice(0, 67) + '...' : l.text)}${verdict}`
    )
    for (const r of l.runs) {
      const lat = r.firstLineAt ? r.firstLineAt - (t0 + l.end) : null
      if (lat !== null) fast.push(lat)
      const timing = r.firstLineAt
        ? `first line ${(lat! / 1000).toFixed(2)}s after speech end (model ${((r.firstLineAt - r.startedAt) / 1000).toFixed(2)}s)`
        : `done in ${(((r.endedAt ?? r.startedAt) - r.startedAt) / 1000).toFixed(2)}s`
      const ttft = r.firstChunkAt
        ? ` first chunk ${((r.firstChunkAt - r.startedAt) / 1000).toFixed(2)}s`
        : ''
      console.log(
        `         -> ${(r.outcome ?? '?').padEnd(9)} ${timing}${r.reason ? ` [${r.reason}]` : ''}${r.error ? ` ERROR ${r.error}` : ''}${ttft}`
      )
      if (process.env.SIM_RAW && r.raw) console.log(r.raw.replace(/^/gm, '            | '))
      if (r.say) {
        console.log(`            ? ${r.prompt}`)
        console.log(`            > ${r.say}`)
        for (const p of r.points ?? []) console.log(`            - ${p}`)
      }
    }
  }
  const unattributed = runs.filter(
    (r) => r.kind === 'auto' && !them.some((l) => l.runs.includes(r))
  )
  if (unattributed.length)
    console.log(
      `  (${unattributed.length} auto runs not matched to a line: ${unattributed.map((r) => r.outcome).join(', ')})`
    )
  console.log('\n  transcript:')
  for (const u of engine.state.utterances)
    console.log(`  ${sec(u.startedAt - t0)}s ${u.speaker === 'you' ? 'You ' : 'Them'}: ${u.text}`)
  const covered = engine.state.cards
    .flatMap((c) => c.sections.flatMap((s) => s.points))
    .filter((p) => p.covered).length
  console.log(`  cards: ${engine.state.cards.length}, points covered by the user: ${covered}`)
  if (fast.length) {
    const sorted = [...fast].sort((a, b) => a - b)
    console.log(
      `  latency speech end -> first card line: median ${(sorted[Math.floor(sorted.length / 2)] / 1000).toFixed(2)}s, max ${(sorted[sorted.length - 1] / 1000).toFixed(2)}s (n=${sorted.length})`
    )
  }
  if (errors.length) pass = false
  console.log(
    `  RESULT: ${pass ? 'PASS' : 'FAIL'}${errors.length ? ` (${errors.length} errors)` : ''}`
  )
  return pass
}

async function main(): Promise<void> {
  loadEnvLocal(ROOT)
  const args = process.argv.slice(2)
  const files = args.length
    ? args
    : readdirSync(__dirname)
        .filter((f) => f.endsWith('.json'))
        .sort()
        .map((f) => join(__dirname, f))
  let ok = true
  for (const f of files) ok = (await runScript(resolve(f))) && ok
  console.log(`\nSIM ${ok ? 'PASSED' : 'FAILED'}`)
  process.exit(ok ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
