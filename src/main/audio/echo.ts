// Echo guards: an energy gate per mic frame and a text guard per utterance. Pure.
import type { Utterance } from '../../shared/types'

export const words = (t: string): string[] => t.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? []

/** A `you` utterance is echo when it overlaps a `them` utterance in time and ≥ 60% of its words appear there.
 *  Echo cannot start before its source: a user who was already talking when they cut in with the same words is kept.
 *  `slackMs` only absorbs clock skew between the two capture helpers; a reply right after them is not echo. */
export function isEcho(you: Utterance, them: Utterance[], slackMs = 150): boolean {
  const mine = words(you.text)
  if (!mine.length) return false
  return them.some((t) => {
    if (t.speaker !== 'them') return false
    if (you.startedAt > t.endedAt + slackMs || you.endedAt < t.startedAt - slackMs) return false
    if (you.startedAt < t.startedAt - slackMs) return false
    const theirs = new Set(words(t.text))
    return mine.filter((w) => theirs.has(w)).length / mine.length >= 0.6
  })
}

// Without AEC the echo is as loud as the speakers, so the gate is relative.
const RAW_SYS_LOUD = 300
const RAW_RATIO = 0.6
// With AEC only a faint residual survives (measured bleed 3800 → 15, bursts of a few hundred), so the
// gate is absolute: it drops mic frames quieter than normal speech, and only while the call is clearly audible.
const AEC_SYS_ACTIVE = 600
const AEC_RESIDUAL_MAX = 400

/**
 * Energy gate: true when a mic frame is most likely the speakers' echo, not the user.
 * `sysRms` is the loudest system-audio frame of the last ~300 ms.
 */
export function isEchoFrame(micRms: number, sysRms: number, aec: boolean): boolean {
  if (aec) return sysRms > AEC_SYS_ACTIVE && micRms < AEC_RESIDUAL_MAX
  return sysRms > RAW_SYS_LOUD && micRms < RAW_RATIO * sysRms
}
