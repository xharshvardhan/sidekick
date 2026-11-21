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
import {
  TASKS,
  contextParts,
  deeperTask,
  screenTask,
  systemPrompt,
  type PendingAudio
} from './prompt'

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
  cardId?: string // the card the run created or extended
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
  now?(): number // clock for records and card times (the replay runs in virtual time); default Date.now
}

const BACKCHANNEL_MS = 700
const YOU_RECENT_MS = 3000
const THINKING_DELAY_MS = 400

interface Gen {
  ctrl: AbortController
  shown: boolean
}

export class Director {
  private gens = new Map<TriggerKind, Gen>()
  /** running deep passes, by section id */
  private deeps = new Map<string, { ctrl: AbortController; cardId: string }>()
  private brief: Brief | null = null
  private briefParts: Part[] = []

  constructor(private d: DirectorDeps) {}

  private now(): number {
    return this.d.now?.() ?? Date.now()
  }

  /** A generation is in flight. */
  get busy(): boolean {
    return this.gens.size > 0
  }

  setBrief(brief: Brief, parts: Part[]): void {
    this.brief = brief
    this.briefParts = parts
  }

  /** They started talking again: drop an auto answer that has not shown anything yet. */
  onThemStart(): void {
    const g = this.gens.get('auto')
    if (g && !g.shown) g.ctrl.abort('they kept talking')
  }

  /** They finished a segment. Audio fast path: run now, the segment audio is in the context. */
  onThemEnd(startedAt: number, endedAt: number): void {
    const dur = endedAt - startedAt
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
    for (const d of this.deeps.values()) d.ctrl.abort('stopped')
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
    rec.endedAt = this.now()
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
    const now = this.now()
    const rec: RunRecord = { kind, startedAt: now, speechEndAt: extra.speechEndAt }
    const askedAt = extra.speechEndAt ?? now
    const source: CardSource = kind
    const { deck } = this.d
    const ctx = this.d.context()
    const s = this.d.settings()
    const shownCard = deck.current // what the model sees as CURRENT CARD; @extend refers to it
    let made: CueKind = 'none'
    let target = null as { card: Card; section: CardSection } | null
    let deep = false

    const apply = (text: string, done: boolean): void => {
      const p = parseCue(text, done)
      deep = p.deep
      if (p.kind === 'none' || !p.say) return
      if (!target) {
        const a = this.d.activity()
        const ext = p.kind === 'extend' ? deck.addSection(askedAt, shownCard?.id) : null
        target = ext ?? deck.addCard(source, askedAt, a, manual)
        made = ext ? 'extend' : 'new'
        rec.cardId = target.card.id
        gen.shown = true
        rec.firstLineAt = this.now()
        // a manual trigger takes over: deep passes on other cards are no longer wanted
        if (manual)
          for (const d of this.deeps.values())
            if (d.cardId !== target.card.id) d.ctrl.abort('replaced by a manual trigger')
      }
      deck.fill(target.section, p)
      target.card.updatedAt = this.now()
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
          rec.firstChunkAt ??= this.now()
          rec.raw = full
          if (!gen.ctrl.signal.aborted) apply(full, false)
        }
      )
      if (gen.ctrl.signal.aborted) throw new DOMException('aborted', 'AbortError')
      apply(text, true)
      rec.outcome = made
      if (target) target.card.status = 'done'
      // the cue asked for depth (an architecture, a derivation, a design, code), or the user asked for help with
      // their screen (always wants the exact next steps): the deep model adds it
      if (target && (deep || kind === 'screen') && !deck.deepDetail.has(target.section.id))
        void this.deepen(target.card, target.section, extra.image)
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
        } else if (manual) deck.addError(source, msg, this.now())
        else this.d.toast('error', `Auto cue failed: ${msg}`)
      }
    } finally {
      this.finish(kind, gen, rec)
    }
  }

  /** Manual "go deeper": the active card's newest section. One deep pass per section; a second press is a no-op. */
  async deeper(): Promise<void> {
    const card = this.d.deck.active
    const section = card?.sections[card.sections.length - 1]
    if (!this.brief || !card || !section) return this.d.toast('info', 'No card to expand yet.')
    if (this.deeps.has(section.id))
      return this.d.toast('info', 'Already adding detail to this card.')
    if (this.d.deck.deepDetail.has(section.id))
      return this.d.toast('info', 'This card already has the in-depth detail.')
    return this.deepen(card, section)
  }

  /** Write a section's detail with the deep model. Runs beside cues (never blocks or cancels them); the cue
   *  still streaming into this section no longer touches its detail. Cancelled or failed: the old detail returns. */
  private async deepen(card: Card, section: CardSection, image?: string): Promise<void> {
    if (!this.brief) return
    const ctrl = new AbortController()
    this.deeps.set(section.id, { ctrl, cardId: card.id })
    const rec: RunRecord = { kind: 'deeper', startedAt: this.now(), cardId: card.id }
    const s = this.d.settings()
    const before = section.detail
    this.d.deck.deepDetail.add(section.id)
    section.deepening = true
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
            task: image ? screenTask(section) : deeperTask(section),
            image // a screen card: the deep model needs the problem itself, not just the card
          }),
          signal: ctrl.signal,
          maxTokens: 4000
        },
        (full) => {
          if (ctrl.signal.aborted) return
          rec.firstLineAt ??= this.now()
          section.detail = full.trim()
          card.updatedAt = this.now()
          this.d.changed()
        }
      )
      if (ctrl.signal.aborted) throw new DOMException('aborted', 'AbortError')
      rec.outcome = 'deeper'
      rec.raw = section.detail
    } catch (e) {
      section.detail = before
      this.d.deck.deepDetail.delete(section.id)
      if (ctrl.signal.aborted || isAbort(e)) {
        rec.outcome = 'cancelled'
        rec.reason = String(ctrl.signal.reason ?? 'aborted')
      } else {
        rec.outcome = 'error'
        rec.error = errorMessage(e)
        this.d.toast('error', `Could not add detail: ${rec.error}`)
      }
    } finally {
      section.deepening = false
      if (this.deeps.get(section.id)?.ctrl === ctrl) this.deeps.delete(section.id)
      rec.endedAt = this.now()
      this.d.changed()
      this.d.onRun?.(rec)
    }
  }
}
