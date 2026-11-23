import { describe, expect, it } from 'vitest'
import { Deck, type UserActivity } from '../src/main/director/cards'
import { Director, type RunRecord } from '../src/main/director/director'
import { idleState } from '../src/main/engine'
import { defaultSettings } from '../src/main/settings'
import type { Llm } from '../src/main/llm'
import type { LiveState } from '../src/shared/types'
import { HOLD_MS, cardHolds, hasCode } from '../src/shared/hold'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

type Reply = string | { text: string; firstChunkMs?: number; chunkMs?: number }

/** A fake model: each call streams the next scripted reply in small chunks. */
function fakeLlm(
  replies: Reply[],
  defaults: { firstChunkMs?: number; chunkMs?: number } = {}
): Llm {
  return {
    models: {
      generateContentStream: async ({ config }: { config: { abortSignal?: AbortSignal } }) => {
        const r = replies.shift() ?? '@none'
        const {
          text,
          firstChunkMs = 20,
          chunkMs = 5
        } = {
          ...defaults,
          ...(typeof r === 'string' ? { text: r } : r)
        }
        return (async function* () {
          await sleep(firstChunkMs)
          for (let i = 0; i < text.length; i += 8) {
            if (config.abortSignal?.aborted) throw new DOMException('aborted', 'AbortError')
            yield { text: text.slice(i, i + 8) }
            await sleep(chunkMs)
          }
        })()
      }
    }
  } as unknown as Llm
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function setup(replies: Reply[], opts?: { firstChunkMs?: number }) {
  const state: LiveState = { ...idleState(), session: 'live' }
  const deck = new Deck(state)
  const runs: RunRecord[] = []
  const toasts: string[] = []
  let act: UserActivity = { now: Date.now(), youSpeaking: false, lastYouSpeechAt: 0 }
  const llm = fakeLlm(replies, opts)
  const director = new Director({
    state,
    deck,
    llm: () => llm,
    settings: () => defaultSettings(),
    context: () => ({ summary: '', tail: [], audio: [] }),
    activity: () => ({ ...act, now: Date.now() }),
    changed: () => {},
    toast: (_k, t) => toasts.push(t),
    onRun: (r) => runs.push(r)
  })
  director.setBrief({ title: 't', preset: 'interview', notes: '', files: [] }, [])
  const setActivity = (a: Partial<UserActivity>): void => {
    act = { ...act, ...a }
  }
  const auto = async (): Promise<void> => {
    const now = Date.now()
    director.onThemEnd(now - 3000, now)
    await sleep(5)
    while (
      state.cards.some((c) => c.status === 'streaming') ||
      (runs.length && !runs[runs.length - 1].endedAt)
    )
      await sleep(10)
    await sleep(200)
  }
  return { state, deck, director, runs, toasts, setActivity, auto }
}

const NEW = (say: string, label = 'A question'): string =>
  `@new\n> ${say}\n- first point here\n- Redis counters with TTL\n? ${label}\n`
const EXT = (say: string): string => `@extend\n> ${say}\n- deeper point\n? A follow-up\n`

describe('card policy (mocked model)', () => {
  it('first @new becomes the active card', async () => {
    const t = setup([NEW('Hello there.')])
    await t.auto()
    expect(t.runs.at(-1)!.outcome).toBe('new')
    expect(t.state.cards).toHaveLength(1)
    expect(t.state.activeCardId).toBe(t.state.cards[0].id)
    const sec = t.state.cards[0].sections[0]
    expect(sec.say).toBe('Hello there.')
    expect(sec.prompt).toBe('A question')
    expect(sec.points.map((p) => p.text)).toEqual(['first point here', 'Redis counters with TTL'])
    expect(t.state.cards[0].status).toBe('done')
  })

  it('@none makes no card', async () => {
    const t = setup(['@none'])
    await t.auto()
    expect(t.runs.at(-1)!.outcome).toBe('none')
    expect(t.state.cards).toHaveLength(0)
  })

  it('@extend adds a section to the current card', async () => {
    const t = setup([NEW('One.'), EXT('Two.')])
    await t.auto()
    await t.auto()
    expect(t.state.cards).toHaveLength(1)
    expect(t.state.cards[0].sections.map((s) => s.say)).toEqual(['One.', 'Two.'])
    expect(t.runs.at(-1)!.outcome).toBe('extend')
  })

  it('a card holds at most 3 sections; the next follow-up starts a new card', async () => {
    const t = setup([NEW('One.'), EXT('Two.'), EXT('Three.'), EXT('Four.')])
    for (let i = 0; i < 4; i++) await t.auto()
    expect(t.state.cards.map((c) => c.sections.map((s) => s.say))).toEqual([
      ['One.', 'Two.', 'Three.'],
      ['Four.']
    ])
    expect(t.runs.at(-1)!.outcome).toBe('new')
  })

  it('a new card while the active one is < 4 s old is queued, then promoted', async () => {
    const t = setup([NEW('One.'), NEW('Two.')])
    await t.auto()
    await t.auto()
    const [a, b] = t.state.cards
    expect(t.state.activeCardId).toBe(a.id)
    expect(t.state.queuedCardId).toBe(b.id)
    expect(t.deck.tick({ now: a.createdAt + 1000, youSpeaking: false, lastYouSpeechAt: 0 })).toBe(
      false
    )
    expect(t.deck.tick({ now: a.createdAt + 4500, youSpeaking: false, lastYouSpeechAt: 0 })).toBe(
      true
    )
    expect(t.state.activeCardId).toBe(b.id)
    expect(t.state.queuedCardId).toBeNull()
  })

  it('a new card while the user is speaking or just spoke waits for 2.5 s of silence', async () => {
    const t = setup([NEW('One.'), NEW('Two.')])
    await t.auto()
    t.state.cards[0].createdAt -= 10_000 // old enough
    t.setActivity({ youSpeaking: true })
    await t.auto()
    expect(t.state.queuedCardId).toBe(t.state.cards[1].id)
    const stoppedAt = Date.now()
    expect(
      t.deck.tick({ now: stoppedAt + 1000, youSpeaking: false, lastYouSpeechAt: stoppedAt })
    ).toBe(false)
    expect(
      t.deck.tick({ now: stoppedAt + 2600, youSpeaking: false, lastYouSpeechAt: stoppedAt })
    ).toBe(true)
    expect(t.state.activeCardId).toBe(t.state.cards[1].id)
  })

  it('pinned: new cards queue and are not promoted; step(1) promotes', async () => {
    const t = setup([NEW('One.'), NEW('Two.')])
    await t.auto()
    t.state.cards[0].createdAt -= 10_000
    t.deck.pin(true)
    await t.auto()
    expect(t.state.queuedCardId).toBe(t.state.cards[1].id)
    expect(t.deck.tick({ now: Date.now() + 60_000, youSpeaking: false, lastYouSpeechAt: 0 })).toBe(
      false
    )
    t.deck.step(1)
    expect(t.state.activeCardId).toBe(t.state.cards[1].id)
    t.deck.step(-1)
    expect(t.state.activeCardId).toBe(t.state.cards[0].id)
  })

  it('they keep talking before the first line: the answer is cancelled and nothing flashes', async () => {
    const t = setup([NEW('Too early.')], { firstChunkMs: 300 })
    const now = Date.now()
    t.director.onThemEnd(now - 3000, now)
    await sleep(50)
    t.director.onThemStart()
    await sleep(400)
    expect(t.runs.at(-1)!.outcome).toBe('cancelled')
    expect(t.state.cards).toHaveLength(0)
  })

  it('backchannel: a short segment right after the user spoke makes no model call', async () => {
    const t = setup([NEW('Should not run.')])
    t.setActivity({ lastYouSpeechAt: Date.now() - 1000 })
    const now = Date.now()
    t.director.onThemEnd(now - 600, now)
    await sleep(100)
    expect(t.runs.at(-1)!.outcome).toBe('skipped')
    expect(t.state.cards).toHaveLength(0)
  })

  it('thinking turns on only after 400 ms of a live generation', async () => {
    const t = setup([NEW('Slow.')], { firstChunkMs: 700 })
    const now = Date.now()
    t.director.onThemEnd(now - 3000, now)
    await sleep(250)
    expect(t.state.thinking).toBe(false)
    await sleep(300)
    expect(t.state.thinking).toBe(true)
    await sleep(800)
    expect(t.state.thinking).toBe(false)
  })

  it('manual ask with a model error shows an error card', async () => {
    const t = setup([])
    const bad = {
      models: { generateContentStream: async () => Promise.reject(new Error('PERMISSION_DENIED')) }
    } as unknown as Llm
    ;(t.director as unknown as { d: { llm: () => Llm } }).d.llm = () => bad
    await t.director.ask('what now?')
    expect(t.state.cards.at(-1)!.status).toBe('error')
    expect(t.state.cards.at(-1)!.error).toMatch(/permission/i)
  })

  it('marks points covered from what the user said since the question', async () => {
    const t = setup([NEW('One.')])
    await t.auto()
    t.deck.applyCoverage([{ text: 'so the first point here is simple', startedAt: Date.now() }])
    const pts = t.state.cards[0].sections[0].points
    expect(pts[0].covered).toBe(true)
    expect(pts[1].covered).toBe(false)
  })

  it('a stale @extend (the card it saw is no longer current) starts a new card instead', async () => {
    const t = setup([NEW('A.'), { text: EXT('Follow-up on A.'), firstChunkMs: 200 }, NEW('B.')])
    await t.auto()
    const now = Date.now()
    t.director.onThemEnd(now - 3000, now) // the model is shown card A
    await sleep(20)
    await t.director.ask('') // card B becomes active before the auto answer streams
    while (t.runs.length < 3) await sleep(10)
    const [a, b] = t.state.cards
    expect(a.sections.map((x) => x.say)).toEqual(['A.'])
    expect(b.sections.map((x) => x.say)).toEqual(['B.'])
    expect(t.state.cards).toHaveLength(3)
  })

  it('Deeper detail is not overwritten by the cue that is still streaming', async () => {
    const t = setup([
      { text: NEW('A long answer that keeps streaming for a while.'), chunkMs: 40 },
      'Deep detail.'
    ])
    const now = Date.now()
    t.director.onThemEnd(now - 3000, now)
    while (!t.state.cards.length) await sleep(5)
    await t.director.deeper()
    while (t.runs.length < 2) await sleep(10)
    const sec = t.state.cards[0].sections[0]
    expect(sec.detail).toBe('Deep detail.')
    expect(sec.points).toHaveLength(2) // the cue still finished its points
  })

  it('pinned: an auto card queues, a manual ask replaces the pinned card', async () => {
    const t = setup([NEW('Pinned.'), NEW('Auto.'), NEW('Asked.')])
    await t.auto()
    const pinned = t.state.cards[0]
    pinned.createdAt -= 10_000
    t.deck.pin(true)
    await t.auto()
    expect(t.state.activeCardId).toBe(pinned.id)
    expect(t.state.queuedCardId).toBe(t.state.cards[1].id)
    await t.director.ask('help')
    expect(t.state.activeCardId).toBe(t.state.cards[2].id)
  })

  it('the first card shows at once even while the user is speaking', async () => {
    const t = setup([NEW('First.')])
    t.setActivity({ youSpeaking: true })
    await t.auto()
    expect(t.state.activeCardId).toBe(t.state.cards[0].id)
    expect(t.state.queuedCardId).toBeNull()
  })
})

/** A coding problem: the cue marks it +code, then the deep pass writes the code. */
const CODE = (say: string): string[] => [
  `@new\n> ${say}\n- two pointers from both ends\n? Trapping rain water\n+code\n`,
  '```python\ndef trap(h):\n    return 0\n```'
]
const quiet = (now: number): UserActivity => ({ now, youSpeaking: false, lastYouSpeechAt: 0 })

describe('holding cards (code the user is typing from)', () => {
  it('hasCode: a language or bare fence is code, a ```text diagram is not', () => {
    expect(hasCode('```python\nx = 1\n```')).toBe(true)
    expect(hasCode('Approach:\n```\nx = 1\n```')).toBe(true)
    expect(hasCode('```text\n[A] --> [B]\n```')).toBe(false)
    expect(hasCode('no fences, `inline` only')).toBe(false)
  })

  it('a code card blocks auto-promotion; the queued card waits for next-card', async () => {
    const t = setup([...CODE('Two pointers, keep the max on each side.'), NEW('Side question.')])
    await t.auto()
    while (t.runs.length < 2) await sleep(10)
    const [code] = t.state.cards
    code.createdAt -= 60_000
    code.updatedAt = code.createdAt // not fresh any more: only the hold keeps it
    await t.auto()
    const side = t.state.cards[1]
    expect(t.state.activeCardId).toBe(code.id)
    expect(t.state.queuedCardId).toBe(side.id)
    expect(t.deck.tick(quiet(Date.now() + 60_000))).toBe(false) // a minute of silence: still holds
    t.deck.step(1)
    expect(t.state.activeCardId).toBe(side.id)
    expect(t.state.queuedCardId).toBeNull()
  })

  it('a snippet that only illustrates a concept does not hold', async () => {
    const snippet =
      '@new\n> noexcept promises no throw.\n- moves stay cheap\n? What noexcept does\n##\n```cpp\nvoid f() noexcept;\n```\n'
    const t = setup([snippet, NEW('Next question.')])
    await t.auto()
    const [first] = t.state.cards
    first.createdAt -= 60_000
    first.updatedAt = first.createdAt
    expect(cardHolds(first, Date.now())).toBe(false)
    await t.auto()
    expect(t.state.activeCardId).toBe(t.state.cards[1].id)
  })

  it('a screen card holds even without code yet', async () => {
    const t = setup([NEW('Here is the approach.'), NEW('Side question.')])
    await t.director.screen('')
    t.state.cards[0].createdAt -= 60_000
    t.state.cards[0].updatedAt = t.state.cards[0].createdAt
    await t.auto()
    expect(t.state.activeCardId).toBe(t.state.cards[0].id)
    expect(t.deck.tick(quiet(Date.now() + 5_000))).toBe(false)
  })

  it('the hold expires 10 minutes after the card last changed', async () => {
    const t = setup([...CODE('Two pointers.'), NEW('Later question.')])
    await t.auto()
    while (t.runs.length < 2) await sleep(10)
    const code = t.state.cards[0]
    const updated = code.updatedAt!
    expect(cardHolds(code, updated + HOLD_MS - 1)).toBe(true)
    expect(cardHolds(code, updated + HOLD_MS)).toBe(false)
    code.createdAt -= HOLD_MS + 1000
    code.updatedAt = code.createdAt
    await t.auto()
    expect(t.state.activeCardId).toBe(t.state.cards[1].id) // nothing holds: shown at once
  })

  it('an expired hold lets a waiting card promote on silence', async () => {
    const t = setup([...CODE('Two pointers.'), NEW('Side question.')])
    await t.auto()
    while (t.runs.length < 2) await sleep(10)
    const code = t.state.cards[0]
    code.createdAt -= 60_000
    code.updatedAt = code.createdAt
    await t.auto()
    expect(t.state.queuedCardId).toBe(t.state.cards[1].id)
    expect(t.deck.tick(quiet(code.updatedAt + HOLD_MS + 1))).toBe(true)
    expect(t.state.activeCardId).toBe(t.state.cards[1].id)
  })

  it('a manual trigger still takes over a holding card at once', async () => {
    const t = setup([...CODE('Two pointers.'), NEW('Asked.')])
    await t.auto()
    while (t.runs.length < 2) await sleep(10)
    await t.director.ask('what now?')
    expect(t.state.activeCardId).toBe(t.state.cards[1].id)
  })
})

const DEEP = (say: string): string =>
  `@new\n> ${say}\n- masked self-attention\n- cross-attention over the encoder\n? Explain the decoder\n+deep\n`

describe('auto deep pass (+deep)', () => {
  it('runs the deep model on the section once the cue finishes', async () => {
    const t = setup([
      DEEP('The decoder predicts one token at a time.'),
      '```text\n[x] --> [y]\n```'
    ])
    await t.auto()
    while (t.runs.length < 2) await sleep(10)
    const sec = t.state.cards[0].sections[0]
    expect(t.runs.map((r) => r.outcome)).toEqual(['new', 'deeper'])
    expect(sec.detail).toBe('```text\n[x] --> [y]\n```')
    expect(sec.deepening).toBe(false)
  })

  it('a screen card hands its screenshot to the deep pass', async () => {
    const t = setup([DEEP('Two pointers.'), 'code'])
    const seen: unknown[] = []
    const llm = (t.director as unknown as { d: { llm: () => Llm } }).d.llm()
    const real = llm.models.generateContentStream.bind(llm.models)
    llm.models.generateContentStream = ((req: { contents: { parts: unknown[] }[] }) => {
      seen.push(req.contents[0].parts.some((p) => (p as { inlineData?: unknown }).inlineData))
      return real(req as never)
    }) as never
    await t.director.screen('aW1n')
    while (t.runs.length < 2) await sleep(10)
    expect(seen).toEqual([true, true])
  })

  it('a screen card always gets the deep pass, with the next-steps task, even without +deep', async () => {
    const t = setup([NEW('Run the export commands.'), '```bash\nexport A=1\n```'])
    const tasks: string[] = []
    const llm = (t.director as unknown as { d: { llm: () => Llm } }).d.llm()
    const real = llm.models.generateContentStream.bind(llm.models)
    llm.models.generateContentStream = ((req: { contents: { parts: { text?: string }[] }[] }) => {
      tasks.push(req.contents[0].parts.at(-1)?.text ?? '')
      return real(req as never)
    }) as never
    await t.director.screen('aW1n')
    while (t.runs.length < 2) await sleep(10)
    expect(t.runs.map((r) => r.outcome)).toEqual(['new', 'deeper'])
    expect(tasks[1]).toMatch(/help with their screen/)
    expect(t.state.cards[0].sections[0].detail).toBe('```bash\nexport A=1\n```')
  })

  it('no +deep, no deep pass', async () => {
    const t = setup([NEW('Hello.'), 'should not be used'])
    await t.auto()
    await sleep(100)
    expect(t.runs.map((r) => r.outcome)).toEqual(['new'])
  })

  it('does not block the next cue, and a manual trigger cancels it and restores the detail', async () => {
    const t = setup([
      DEEP('The decoder predicts one token at a time.'),
      { text: 'Deep detail that streams slowly for quite a while.', firstChunkMs: 30, chunkMs: 60 },
      NEW('Next question answered.')
    ])
    await t.auto()
    const sec = t.state.cards[0].sections[0]
    while (!sec.detail) await sleep(5) // the deep pass is writing
    expect(sec.deepening).toBe(true)
    await t.director.ask('help') // a new card while the deep pass runs
    expect(t.state.cards[1].sections[0].say).toBe('Next question answered.')
    while (t.runs.length < 3) await sleep(10)
    const deep = t.runs.find((r) => r.kind === 'deeper')!
    expect(deep.outcome).toBe('cancelled')
    expect(sec.detail).toBe('')
    expect(sec.deepening).toBe(false)
  })

  it('manual go-deeper on a section that already has deep detail is a no-op with a toast', async () => {
    const t = setup([DEEP('The decoder.'), 'Deep detail.'])
    await t.auto()
    while (t.runs.length < 2) await sleep(10)
    await t.director.deeper()
    expect(t.runs).toHaveLength(2)
    expect(t.toasts.at(-1)).toMatch(/already/i)
  })
})
