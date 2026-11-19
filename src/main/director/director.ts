// The director: decides when to help and streams cards. No Electron imports (the sim drives it headlessly).
import type { Part } from '@google/genai'
import type {
  Brief,
  Card,
  CardSection,
  CardSource,
  LiveState,
  Settings,
  Utterance
} from '../../shared/types'
import { errorMessage, isAbort, streamText, type Llm } from '../llm'
import { Deck, type UserActivity } from './cards'
import { parseCue, type CueKind } from './protocol'
import { TASKS, contextParts, deeperTask, systemPrompt, type PendingAudio } from './prompt'

export type TriggerKind = 'auto' | 'ask' | 'screen' | 'deeper'
export type Outcome = CueKind | 'skipped' | 'cancelled' | 'error' | 'deeper'

export interface RunRecord {
  kind: TriggerKind
  startedAt: number // trigger time
  speechEndAt?: number // auto: end of their speech (audio time)
  firstChunkAt?: number // first streamed text from the model
  firstLineAt?: number // first say text on screen
  endedAt?: number
  outcome?: Outcome
  say?: string
  prompt?: string
  points?: string[]
  error?: string
  reason?: string // why skipped/cancelled
  raw?: string // the model's full reply (sim/debug)
}

export interface DirectorDeps {
  state: LiveState
  deck: Deck
  llm(): Llm
  settings(): Settings
  context(): {
    summary: string
    tail: Utterance[]
    audio: PendingAudio[]
    audioOmittedMs?: number
  }
  activity(): UserActivity
  changed(): void
  toast(kind: 'info' | 'error', text: string): void
  onRun?(r: RunRecord): void
}

const BACKCHANNEL_MS = 1200
const YOU_RECENT_MS = 3000
const MONOLOGUE_MS = 20_000
const THINKING_DELAY_MS = 400

interface Gen {
  ctrl: AbortController
  shown: boolean
}

export class Director {
  private gens = new Map<TriggerKind, Gen>()
  private themPendingMs = 0 // their speech since the last auto answer
  private brief: Brief | null = null
  private briefParts: Part[] = []

  constructor(private d: DirectorDeps) {}

  setBrief(brief: Brief, parts: Part[]): void {
    this.brief = brief
    this.briefParts = parts
  }

  /** They started talking again: drop an auto answer that has not shown anything yet. */
  onThemStart(): void {
    const g = this.gens.get('auto')
    if (g && !g.shown && this.themPendingMs <= MONOLOGUE_MS) g.ctrl.abort('they kept talking')
  }

  /** They finished a segment. Audio fast path: run now, the segment audio is in the context. */
  onThemEnd(startedAt: number, endedAt: number): void {
    const dur = endedAt - startedAt
    this.themPendingMs += dur
    if (!this.d.state.autoCue || this.d.state.session !== 'live') return
    const a = this.d.activity()
    if (
      dur < BACKCHANNEL_MS &&
      (a.youSpeaking || (a.lastYouSpeechAt && a.now - a.lastYouSpeechAt < YOU_RECENT_MS))
    ) {
      this.d.onRun?.({
        kind: 'auto',
        startedAt: a.now,
        speechEndAt: endedAt,
        endedAt: a.now,
        outcome: 'skipped',
        reason: 'backchannel'
      })
      return
    }
    void this.run('auto', TASKS.auto, { speechEndAt: endedAt })
  }

  ask(question: string): Promise<void> {
    const q = question.trim()
    return this.run('ask', q ? TASKS.ask(q) : TASKS.help)
  }

  screen(jpegBase64: string): Promise<void> {
    return this.run('screen', TASKS.screen, { image: jpegBase64 })
  }

  cancelAll(): void {
    for (const g of this.gens.values()) g.ctrl.abort('stopped')
  }

  private start(kind: TriggerKind): Gen {
    this.gens.get(kind)?.ctrl.abort('replaced by a newer trigger')
    const gen: Gen = { ctrl: new AbortController(), shown: false }
    this.gens.set(kind, gen)
    setTimeout(() => {
      if (this.gens.get(kind) === gen && !gen.ctrl.signal.aborted) {
        this.d.state.thinking = true
        this.d.changed()
      }
    }, THINKING_DELAY_MS)
    return gen
  }

  private finish(kind: TriggerKind, gen: Gen, rec: RunRecord): void {
    if (this.gens.get(kind) === gen) this.gens.delete(kind)
    if (!this.gens.size) this.d.state.thinking = false
    rec.endedAt = Date.now()
    this.d.changed()
    this.d.onRun?.(rec)
  }

  private async run(
    kind: Exclude<TriggerKind, 'deeper'>,
    task: string,
    extra: { speechEndAt?: number; image?: string } = {}
  ): Promise<void> {
    if (!this.brief) return
    const manual = kind !== 'auto'
    const gen = this.start(kind)
    const now = Date.now()
    const rec: RunRecord = { kind, startedAt: now, speechEndAt: extra.speechEndAt }
    const askedAt = extra.speechEndAt ?? now
    const source: CardSource = kind
    const { deck } = this.d
    const ctx = this.d.context()
    const s = this.d.settings()
    const shownCard = deck.current // what the model sees as CURRENT CARD; @extend refers to it
    let made: CueKind = 'none'
    let target = null as { card: Card; section: CardSection } | null

    const apply = (text: string, done: boolean): void => {
      const p = parseCue(text, done)
      if (p.kind === 'none' || !p.say) return
      if (!target) {
        const a = this.d.activity()
        const ext = p.kind === 'extend' ? deck.addSection(askedAt, shownCard?.id) : null
        target = ext ?? deck.addCard(source, askedAt, a, manual)
        made = ext ? 'extend' : 'new'
        gen.shown = true
        rec.firstLineAt = Date.now()
        if (kind === 'auto') this.themPendingMs = 0
      }
      deck.fill(target.section, p)
      rec.say = p.say
      rec.prompt = p.prompt
      rec.points = p.points
      this.d.changed()
    }

    try {
      const text = await streamText(
        this.d.llm(),
        {
          model: s.models.cue,
          system: systemPrompt(this.brief, s),
          parts: contextParts({
            briefParts: this.briefParts,
            ...ctx,
            card: shownCard,
            task,
            image: extra.image
          }),
          signal: gen.ctrl.signal,
          maxTokens: 1200
        },
        (full) => {
          rec.firstChunkAt ??= Date.now()
          rec.raw = full
          if (!gen.ctrl.signal.aborted) apply(full, false)
        }
      )
      if (gen.ctrl.signal.aborted) throw new DOMException('aborted', 'AbortError')
      apply(text, true)
      rec.outcome = made
      if (target) target.card.status = 'done'
      if (kind === 'auto') this.themPendingMs = 0
      if (!target && manual) this.d.toast('info', 'Nothing useful to add right now.')
    } catch (e) {
      if (gen.ctrl.signal.aborted || isAbort(e)) {
        rec.outcome = 'cancelled'
        rec.reason = String(gen.ctrl.signal.reason ?? 'aborted')
        if (target) target.card.status = 'done'
      } else {
        const msg = errorMessage(e)
        rec.outcome = 'error'
        rec.error = msg
        if (target) {
          target.card.status = 'error'
          target.card.error = msg
        } else if (manual) deck.addError(source, msg, Date.now())
        else this.d.toast('error', `Auto cue failed: ${msg}`)
      }
    } finally {
      this.finish(kind, gen, rec)
    }
  }

  /** Expand the active card's newest section with the deep model. */
  async deeper(): Promise<void> {
    const card = this.d.deck.active
    const section = card?.sections[card.sections.length - 1]
    if (!this.brief || !card || !section) {
      this.d.toast('info', 'No card to expand yet.')
      return
    }
    const gen = this.start('deeper')
    const rec: RunRecord = { kind: 'deeper', startedAt: Date.now() }
    const s = this.d.settings()
    const before = section.detail
    this.d.deck.deepDetail.add(section.id)
    card.status = 'streaming'
    this.d.changed()
    try {
      const ctx = this.d.context()
      await streamText(
        this.d.llm(),
        {
          model: s.models.deep,
          system: systemPrompt(this.brief, s),
          parts: contextParts({
            briefParts: this.briefParts,
            summary: ctx.summary,
            tail: ctx.tail,
            audio: [],
            card,
            task: deeperTask(card)
          }),
          signal: gen.ctrl.signal,
          maxTokens: 2000
        },
        (full) => {
          if (gen.ctrl.signal.aborted) return
          if (!rec.firstLineAt) rec.firstLineAt = Date.now()
          section.detail = full.trim()
          this.d.changed()
        }
      )
      rec.outcome = 'deeper'
      card.status = 'done'
    } catch (e) {
      card.status = 'done'
      if (gen.ctrl.signal.aborted || isAbort(e)) rec.outcome = 'cancelled'
      else {
        section.detail = before
        this.d.deck.deepDetail.delete(section.id)
        rec.outcome = 'error'
        rec.error = errorMessage(e)
        this.d.toast('error', `Could not expand the card: ${rec.error}`)
      }
    } finally {
      this.finish('deeper', gen, rec)
    }
  }
}
