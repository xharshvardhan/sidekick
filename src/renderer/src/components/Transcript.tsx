import { useEffect, useRef, type ReactNode } from 'react'
import { LoadingDots } from '@openai/apps-sdk-ui/components/Indicator'
import type { Speaker, Utterance } from '../../../shared/types'
import { timeOfDay } from '../lib'

interface Turn {
  id: string
  speaker: Speaker
  at: number
  texts: string[]
}

function toTurns(utterances: Utterance[]): Turn[] {
  const turns: Turn[] = []
  for (const u of utterances) {
    const last = turns[turns.length - 1]
    if (last && last.speaker === u.speaker) last.texts.push(u.text)
    else turns.push({ id: u.id, speaker: u.speaker, at: u.startedAt, texts: [u.text] })
  }
  return turns
}

export function Transcript({
  utterances,
  partial,
  empty
}: {
  utterances: Utterance[]
  partial?: { you: boolean; them: boolean }
  empty: ReactNode
}): ReactNode {
  const ref = useRef<HTMLDivElement>(null)
  const pinnedToBottom = useRef(true)
  const turns = toTurns(utterances)

  // Follow new speech only when the reader is already at the bottom.
  useEffect(() => {
    const el = ref.current
    if (el && pinnedToBottom.current) el.scrollTop = el.scrollHeight
  }, [utterances.length, partial?.you, partial?.them])

  return (
    <div
      ref={ref}
      className="h-full overflow-y-auto px-5 py-4"
      onScroll={(e) => {
        const el = e.currentTarget
        pinnedToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
      }}
    >
      {turns.length === 0 && !partial?.you && !partial?.them ? (
        empty
      ) : (
        <div className="flex flex-col gap-3">
          {turns.map((t) => (
            <TurnBubble key={t.id} turn={t} />
          ))}
          {partial?.them && <Speaking speaker="them" />}
          {partial?.you && <Speaking speaker="you" />}
        </div>
      )}
    </div>
  )
}

function TurnBubble({ turn }: { turn: Turn }): ReactNode {
  const you = turn.speaker === 'you'
  return (
    <div className={`flex flex-col ${you ? 'items-end' : 'items-start'}`}>
      <span className="mb-1 px-1 text-xs text-tertiary">
        {you ? 'You' : 'Them'} · {timeOfDay(turn.at)}
      </span>
      <div
        className={`selectable max-w-[85%] space-y-1.5 rounded-2xl px-3.5 py-2 text-sm leading-relaxed ${
          you ? 'rounded-tr-md bg-bubble-you' : 'rounded-tl-md border border-default bg-surface'
        }`}
      >
        {turn.texts.map((t, i) => (
          <p key={i}>{t}</p>
        ))}
      </div>
    </div>
  )
}

function Speaking({ speaker }: { speaker: Speaker }): ReactNode {
  const you = speaker === 'you'
  return (
    <div
      className={`flex items-center gap-2 px-1 text-xs text-tertiary ${you ? 'justify-end' : ''}`}
    >
      <LoadingDots className="text-tertiary" />
      {you ? 'You are speaking…' : 'They are speaking…'}
    </div>
  )
}
