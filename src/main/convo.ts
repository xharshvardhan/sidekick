// Conversation store: utterances in time order plus the rolling summary of older ones. No Electron imports.
import type { Utterance } from '../shared/types'
import { generateText, type Llm } from './llm'
import { SUMMARY_PROMPT, transcriptText } from './director/prompt'

const TAIL = 30 // utterances the prompt carries verbatim
const FOLD_EVERY = 15 // new utterances between folds
const FOLD_MS = 3 * 60_000

export class Conversation {
  summary = ''
  private folded = 0 // utterances[0..folded) are in the summary
  private lastFoldAt = Date.now()
  private lastFoldLen = 0
  private folding = false

  constructor(public utterances: Utterance[]) {}

  /** Insert keeping `startedAt` order (transcripts can finish out of order). */
  add(u: Utterance): void {
    let i = this.utterances.length
    while (i > 0 && this.utterances[i - 1].startedAt > u.startedAt) i--
    this.utterances.splice(i, 0, u)
    if (i < this.folded) this.folded++ // keep the folded boundary on the same utterances
  }

  remove(ids: Set<string>): void {
    const before = this.utterances.slice(0, this.folded).filter((u) => ids.has(u.id)).length
    this.folded -= before
    for (let i = this.utterances.length - 1; i >= 0; i--)
      if (ids.has(this.utterances[i].id)) this.utterances.splice(i, 1)
  }

  /** The verbatim part of the conversation the prompt carries. */
  tail(): Utterance[] {
    return this.utterances.slice(Math.max(this.folded, this.utterances.length - TAIL))
  }

  /** Fold older utterances into the summary every 3 minutes or 15 new utterances (only when the tail overflows). */
  async maybeFold(ai: Llm, model: string, now = Date.now()): Promise<boolean> {
    const n = this.utterances.length
    if (this.folding || n - this.folded <= TAIL) return false
    if (n - this.lastFoldLen < FOLD_EVERY && now - this.lastFoldAt < FOLD_MS) return false
    const upTo = n - Math.floor(TAIL * 0.66)
    const chunk = this.utterances.slice(this.folded, upTo)
    this.folding = true
    try {
      const text = await generateText(ai, {
        model,
        maxTokens: 1500, // room to spare: a summary cut off mid-word loses the newest part of the call
        parts: [
          {
            text: `${SUMMARY_PROMPT}\n\nRUNNING SUMMARY\n${this.summary || '(empty)'}\n\nNEW TRANSCRIPT\n${transcriptText(chunk)}`
          }
        ]
      })
      if (text.trim()) {
        this.summary = text.trim()
        // Transcripts may have landed inside the chunk's time range meanwhile: advance the boundary only
        // over utterances that were actually summarized, so a late one stays in the verbatim tail.
        const done = new Set(chunk)
        let i = this.folded
        while (i < this.utterances.length && done.has(this.utterances[i])) i++
        this.folded = i
      }
      return true
    } finally {
      this.lastFoldAt = now
      this.lastFoldLen = n
      this.folding = false
    }
  }
}
