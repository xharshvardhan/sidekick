// When the active card "holds": the user is working from it (typing out a coding problem, following steps for
// their screen), so a new card must not replace it on its own. A snippet that only illustrates a concept does not hold. Pure; main (card policy) and the overlay (the "Next" peek) both use it.
import type { Card } from './types'

export const HOLD_MS = 10 * 60_000

const DIAGRAM = /^(text|txt|plaintext|ascii|diagram)$/i

/** Diagrams are fenced as ```text; any other fenced block (tagged with a language or untagged) is code. */
export function hasCode(markdown: string): boolean {
  let inFence = false
  for (const line of markdown.split('\n')) {
    const m = /^\s*```\s*(\S*)/.exec(line)
    if (!m) continue
    if (!inFence && !DIAGRAM.test(m[1])) return true
    inFence = !inFence
  }
  return false
}

export function cardHolds(card: Card | undefined, now: number): boolean {
  if (!card || card.status === 'error') return false
  if (now - (card.updatedAt ?? card.createdAt) >= HOLD_MS) return false
  return card.source === 'screen' || card.sections.some((s) => s.coding)
}
