// Text echo guard for when the mic runs without echo cancellation. Pure.
import type { Utterance } from '../../shared/types'

export const words = (t: string): string[] => t.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? []

/** A `you` utterance is echo when it overlaps a `them` utterance in time and ≥ 60% of its words appear there. */
export function isEcho(you: Utterance, them: Utterance[], slackMs = 500): boolean {
  const mine = words(you.text)
  if (!mine.length) return false
  return them.some((t) => {
    if (t.speaker !== 'them') return false
    if (you.startedAt > t.endedAt + slackMs || you.endedAt < t.startedAt - slackMs) return false
    const theirs = new Set(words(t.text))
    return mine.filter((w) => theirs.has(w)).length / mine.length >= 0.6
  })
}
