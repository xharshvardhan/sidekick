// Card policy: which card is active, which is queued, how streaming output lands in sections.
// Pure (no Electron, no model). Mutates the card fields of a LiveState-shaped object.
import type { Card, CardSection, CardSource, LiveState } from '../../shared/types'
import type { ParsedCue } from './protocol'
import { isCovered } from './coverage'
import { cardHolds } from '../../shared/hold'

export type DeckState = Pick<LiveState, 'cards' | 'activeCardId' | 'queuedCardId' | 'pinned'>

export const QUIET_MS = 2500 // user silence before a queued card is promoted
export const FRESH_MS = 4000 // an active card younger than this is not replaced
export const MAX_SECTIONS = 3 // a follow-up beyond this starts a new card

let seq = 0
export const newId = (p: string): string => `${p}${Date.now().toString(36)}${(seq++).toString(36)}`

export interface UserActivity {
  now: number
  youSpeaking: boolean
  lastYouSpeechAt: number // epoch ms when the user last stopped speaking (0 = never)
  youSpeechStartedAt?: number // epoch ms when the user's current or latest speech began
}

export class Deck {
  /** section id → when its question was asked (for coverage) */
  private sectionStart = new Map<string, number>()
  /** sections whose detail the deep model wrote; a still-streaming cue must not overwrite it */
  deepDetail = new Set<string>()

  constructor(public s: DeckState) {}

  get active(): Card | undefined {
    return this.s.cards.find((c) => c.id === this.s.activeCardId)
  }
  get queued(): Card | undefined {
    return this.s.cards.find((c) => c.id === this.s.queuedCardId)
  }
  /** The card the conversation is currently about (a queued card is newer than the active one). */
  get current(): Card | undefined {
    return this.queued ?? this.active
  }

  /** Should a brand-new card wait in the queue instead of replacing what the user is reading?
   *  A holding card (code the user is typing from) keeps it queued until they step to it. */
  shouldQueue(a: UserActivity, answering = false): boolean {
    const active = this.active
    return (
      this.s.pinned ||
      cardHolds(active, a.now) ||
      (!answering &&
        (a.youSpeaking || (a.lastYouSpeechAt > 0 && a.now - a.lastYouSpeechAt < QUIET_MS))) ||
      (!!active && a.now - active.createdAt < FRESH_MS)
    )
  }

  /** Start a new card with one empty section. `askedAt` is when the question ended. */
  addCard(
    source: CardSource,
    askedAt: number,
    a: UserActivity,
    forceActive = false
  ): { card: Card; section: CardSection } {
    const section = this.newSection(askedAt)
    const card: Card = {
      id: newId('c'),
      createdAt: a.now,
      source,
      status: 'streaming',
      sections: [section]
    }
    this.s.cards.push(card)
    // The user began talking after this question ended: they are answering it, not reading the old card.
    const answering = (a.youSpeechStartedAt ?? 0) > askedAt
    if (!forceActive && this.active && this.shouldQueue(a, answering)) this.s.queuedCardId = card.id
    else this.activate(card.id)
    return { card, section }
  }

  /** Add a follow-up section to the current card, which must still be `expectedId` (the card the model
   *  was shown). Returns null when there is nothing to extend or the card is full, so the caller starts a new card. */
  addSection(
    askedAt: number,
    expectedId: string | undefined
  ): { card: Card; section: CardSection } | null {
    const card = this.current
    if (!card || card.id !== expectedId || card.sections.length >= MAX_SECTIONS) return null
    if (this.s.pinned && card.id === this.s.activeCardId) return null // pinned cards are frozen
    const section = this.newSection(askedAt)
    card.sections.push(section)
    card.status = 'streaming'
    return { card, section }
  }

  /** Copy parsed stream output into a section. Streaming only appends, so this is a plain overwrite. */
  fill(section: CardSection, p: ParsedCue): void {
    section.say = p.say
    if (p.prompt) section.prompt = p.prompt
    if (p.code) section.coding = true
    if (!this.deepDetail.has(section.id)) section.detail = p.detail
    section.points = p.points.map((text, i) => {
      const old = section.points[i]
      return { id: old?.id ?? newId('p'), text, covered: old?.covered ?? false }
    })
  }

  /** The deep pass may open with "**Correction (point 2):** …" lines. The user reads the points word for word, so a
   *  fix replaces the wrong line in place (a fix that names no line becomes the section's note). Returns the detail
   *  without those lines. Called on every chunk with the full text so far; `done` = the stream has ended. */
  correct(section: CardSection, text: string, done: boolean): string {
    const lines = text.split('\n')
    const notes: string[] = []
    let i = 0
    for (; i < lines.length; i++) {
      const line = lines[i].trim()
      if (!line) continue
      const head = '**Correction'
      if (!(line.length < head.length ? head.startsWith(line) : line.startsWith(head))) break
      if (i === lines.length - 1 && !done) return '' // the line is still streaming
      const m = /^\*\*Correction(?:\s*\((say|point\s*(\d+))\))?:?\*\*:?\s*(.+)$/i.exec(line)
      if (!m) break
      const fix = m[3].trim()
      const point = m[2] ? section.points[Number(m[2]) - 1] : undefined
      if (point) {
        const text = fix.replace(/\.$/, '')
        if (point.text !== text) {
          point.was ??= point.text
          point.text = text
          point.covered = false
        }
      } else if (m[1]?.toLowerCase() === 'say') {
        if (section.say !== fix) {
          section.sayWas ??= section.say
          section.say = fix
        }
      } else notes.push(fix)
    }
    section.note = notes.join(' ') || undefined
    return lines.slice(i).join('\n').trim()
  }

  addError(source: CardSource, message: string, now: number): Card {
    const card: Card = {
      id: newId('c'),
      createdAt: now,
      source,
      status: 'error',
      sections: [],
      error: message
    }
    this.s.cards.push(card)
    this.activate(card.id)
    return card
  }

  /** Promote the queued card once the user has been quiet long enough. Returns true if something changed. */
  tick(a: UserActivity): boolean {
    if (!this.queued) return false
    if (this.active && this.shouldQueue(a)) return false
    this.activate(this.queued.id)
    return true
  }

  step(dir: -1 | 1): void {
    if (dir === 1 && this.queued) return this.activate(this.queued.id)
    const i = this.s.cards.findIndex((c) => c.id === this.s.activeCardId)
    const next =
      this.s.cards[
        Math.max(0, Math.min(this.s.cards.length - 1, (i < 0 ? this.s.cards.length : i) + dir))
      ]
    if (next) this.activate(next.id)
  }

  show(id: string): void {
    if (this.s.cards.some((c) => c.id === id)) this.activate(id)
  }

  pin(on: boolean): void {
    this.s.pinned = on
  }

  /** Mark covered points from the user's utterances. Returns true if any point changed. */
  applyCoverage(youSaid: { text: string; startedAt: number }[]): boolean {
    let changed = false
    for (const card of this.s.cards.slice(-3)) {
      for (const sec of card.sections) {
        const since = this.sectionStart.get(sec.id) ?? card.createdAt
        const said = youSaid
          .filter((u) => u.startedAt >= since - 1000)
          .map((u) => u.text)
          .join(' ')
        if (!said) continue
        for (const p of sec.points) {
          if (!p.covered && isCovered(p.text, said)) {
            p.covered = true
            changed = true
          }
        }
      }
    }
    return changed
  }

  private newSection(askedAt: number): CardSection {
    const section: CardSection = { id: newId('s'), prompt: '', say: '', points: [], detail: '' }
    this.sectionStart.set(section.id, askedAt)
    return section
  }

  private activate(id: string): void {
    this.s.activeCardId = id
    if (this.s.queuedCardId === id) this.s.queuedCardId = null
    // anything queued that is older than what's now active is stale
    const q = this.queued
    if (q && this.s.cards.indexOf(q) < this.s.cards.findIndex((c) => c.id === id))
      this.s.queuedCardId = null
  }
}
