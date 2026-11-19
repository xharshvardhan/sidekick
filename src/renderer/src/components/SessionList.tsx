import { useEffect, useState, type ReactNode } from 'react'
import { ChevronRight, History as HistoryIcon } from 'lucide-react'
import { EmptyMessage } from '@openai/apps-sdk-ui/components/EmptyMessage'
import { LoadingIndicator } from '@openai/apps-sdk-ui/components/Indicator'
import type { SessionMeta } from '../../../shared/types'
import { sk } from '../bridge'
import { go, minutes, presetLabel, when } from '../lib'
import { errText, useStore } from '../store'

export function useSessions(): { sessions: SessionMeta[] | null; error: string } {
  const [sessions, setSessions] = useState<SessionMeta[] | null>(null)
  const [error, setError] = useState('')
  const liveState = useStore((s) => s.live?.session)
  useEffect(() => {
    sk()
      .invoke('session:list')
      .then((list) => setSessions([...list].sort((a, b) => b.startedAt - a.startedAt)))
      .catch((e) => setError(errText(e)))
  }, [liveState])
  return { sessions, error }
}

export function SessionList({ limit }: { limit?: number }): ReactNode {
  const { sessions, error } = useSessions()
  if (error) return <p className="py-6 text-sm text-danger">Couldn't load sessions: {error}</p>
  if (!sessions)
    return (
      <div className="flex items-center gap-2 py-6 text-sm text-secondary">
        <LoadingIndicator size={14} /> Loading sessions…
      </div>
    )
  if (sessions.length === 0)
    return (
      <EmptyMessage className="py-10">
        <EmptyMessage.Icon>
          <HistoryIcon />
        </EmptyMessage.Icon>
        <EmptyMessage.Title>No sessions yet</EmptyMessage.Title>
        <EmptyMessage.Description>
          Each call you run is saved here with its transcript, the cards you saw, and a recap.
        </EmptyMessage.Description>
      </EmptyMessage>
    )
  return (
    <ul className="divide-y divide-[var(--color-border-subtle)] overflow-hidden rounded-xl border border-default bg-surface">
      {sessions.slice(0, limit).map((s) => (
        <li key={s.id}>
          <button
            onClick={() => go(`session/${s.id}`)}
            className="flex w-full items-center gap-4 px-4 py-3 text-left hover:bg-[var(--alpha-04)]"
          >
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium">{s.title}</div>
              <div className="mt-0.5 text-xs text-secondary">
                {when(s.startedAt)}
                {s.endedAt ? ` · ${minutes(s.endedAt - s.startedAt)}` : ' · in progress'}
              </div>
            </div>
            <span className="hidden w-20 text-xs text-secondary sm:block">
              {presetLabel(s.preset)}
            </span>
            <span className="w-16 text-right text-xs text-tertiary tabular-nums">
              {s.cardCount} {s.cardCount === 1 ? 'card' : 'cards'}
            </span>
            <ChevronRight className="size-4 text-tertiary" />
          </button>
        </li>
      ))}
    </ul>
  )
}
