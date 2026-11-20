// Deep-dive check with real models: each question goes through the cue model as if they had just asked it, then
// (on +deep) through the automatic deep pass. Prints both outputs and the timings, and flags diagram lines wider
// than the overlay fits. Usage: npm run deep [-- <substring filter> | "<your own question?>"]
import { mkdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import type { LiveState } from '../../src/shared/types'
import { Deck } from '../../src/main/director/cards'
import { Director, type RunRecord } from '../../src/main/director/director'
import { parseCue } from '../../src/main/director/protocol'
import { idleState } from '../../src/main/engine'
import { loadEnvLocal } from '../../src/main/env'
import { makeLlm } from '../../src/main/llm'
import { defaultSettings } from '../../src/main/settings'

const DEEP = [
  'What is the difference between the transformer encoder and the decoder?',
  'Can you draw the transformer architecture end to end for me?',
  'Walk me through the math of the attention mechanism.',
  'How would you design a rate limiter for our public API?',
  'Explain how leader election works in Raft.',
  'How does an insert work in a B-tree?',
  'Okay, coding question: reverse a linked list, in Python please.',
  'How does LoRA fine-tuning work?'
]
const SHALLOW = [
  'Great, to start, can you introduce yourself?',
  'Why are you looking to leave your current role?',
  'Do you know Java?',
  "That's all from my side. Do you have any questions for us?"
]
const MAX_COLS = 58

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const s = (ms?: number): string => (ms === undefined ? '   -  ' : `${(ms / 1000).toFixed(1)}s`.padStart(6))

/** Lines inside ```text diagram blocks wider than the overlay (code may scroll sideways; diagrams must fit). */
function wideLines(md: string): string[] {
  let fence: string | null = null
  const out: string[] = []
  for (const line of md.split('\n')) {
    const m = /^\s*```\s*(\S*)/.exec(line)
    if (m) fence = fence === null ? m[1] : null
    else if (fence === 'text' && [...line].length > MAX_COLS) out.push(line)
  }
  return out
}

async function ask(question: string): Promise<{ cue?: RunRecord; deep?: RunRecord; detail: string }> {
  const settings = { ...defaultSettings(process.env), profile: '' }
  const llm = makeLlm(settings.vertex)
  const state: LiveState = { ...idleState(), session: 'live' }
  const deck = new Deck(state)
  const runs: RunRecord[] = []
  const now = Date.now()
  const director = new Director({
    state,
    deck,
    llm: () => llm,
    settings: () => settings,
    context: () => ({
      summary: '',
      tail: [{ id: 'u1', speaker: 'them', text: question, startedAt: now - 4000, endedAt: now }],
      audio: []
    }),
    activity: () => ({ now: Date.now(), youSpeaking: false, lastYouSpeechAt: 0 }),
    changed: () => {},
    toast: (kind, text) => console.log(`  [toast ${kind}] ${text}`),
    onRun: (r) => runs.push(r)
  })
  director.setBrief(
    {
      title: 'Senior ML engineer, technical round',
      preset: 'interview',
      notes: '',
      files: [],
      details: [{ label: 'Role', value: 'Senior ML / backend engineer' }]
    },
    []
  )
  director.onThemEnd(now - 4000, now)
  const done = (): boolean => {
    const cue = runs.find((r) => r.kind === 'auto')
    if (!cue) return false
    const shown = cue.outcome === 'new' || cue.outcome === 'extend'
    return !shown || !parseCue(cue.raw ?? '', true).deep || runs.some((r) => r.kind === 'deeper')
  }
  for (const t0 = Date.now(); !done() && Date.now() - t0 < 90_000; ) await sleep(50)
  return {
    cue: runs.find((r) => r.kind === 'auto'),
    deep: runs.find((r) => r.kind === 'deeper'),
    detail: state.cards[0]?.sections[0]?.detail ?? ''
  }
}

async function main(): Promise<void> {
  loadEnvLocal(resolve(__dirname, '../..'))
  const filter = process.argv[2]?.toLowerCase()
  const all = [...DEEP.map((q) => ({ q, want: true })), ...SHALLOW.map((q) => ({ q, want: false }))]
  const rows: string[] = []
  const saved: unknown[] = []
  let ok = true
  // all questions at once (separate requests; Vertex latency is per request)
  const own = process.argv[2]?.endsWith('?') ? [{ q: process.argv[2], want: true }] : null
  const picked = own ?? all.filter((x) => !filter || x.q.toLowerCase().includes(filter))
  const results = await Promise.all(picked.map((x) => ask(x.q)))
  for (const [i, { q, want }] of picked.entries()) {
    const { cue, deep, detail } = results[i]
    const deepAsked = parseCue(cue?.raw ?? '', true).deep
    const t = cue?.startedAt ?? 0
    const wide = wideLines(detail)
    const pass = deepAsked === want && (!want || (deep?.outcome === 'deeper' && !wide.length))
    ok &&= pass
    console.log(`\n=== ${q}`)
    console.log(cue?.raw?.trim().replace(/^/gm, '  | ') ?? '  (no cue)')
    if (deep) console.log(`  --- deep (${deep.outcome}${deep.error ? ` ${deep.error}` : ''}):\n${detail}`)
    if (wide.length) console.log(`  !! ${wide.length} diagram lines wider than ${MAX_COLS} columns`)
    rows.push(
      `| ${q.slice(0, 58).padEnd(58)} | ${deepAsked ? '+deep' : '  -  '} | ${s(cue?.firstLineAt && cue.firstLineAt - t)} | ${s(deep?.firstLineAt && deep.firstLineAt - t)} | ${s(deep?.endedAt && deep.endedAt - t)} | ${String(detail.split(/\s+/).filter(Boolean).length).padStart(5)} | ${wide.length ? `${wide.length} wide` : pass ? 'ok' : 'FAIL'} |`
    )
    saved.push({ q, cue, deep, detail })
  }
  console.log(
    `\n| question${' '.repeat(51)}| marker | first line | deep starts | deep done | words | check |\n|${'-'.repeat(60)}|-------|--------|--------|--------|-------|------|`
  )
  for (const r of rows) console.log(r)
  const dir = join(tmpdir(), 'sidekick-deep')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `deep-${Date.now()}.json`)
  writeFileSync(file, JSON.stringify(saved, null, 1))
  console.log(`\nraw outputs: ${file}\nDEEP ${ok ? 'PASSED' : 'FAILED'}`)
  process.exit(ok ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
