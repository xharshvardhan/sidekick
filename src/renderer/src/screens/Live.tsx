import { useState, type ReactNode } from 'react'
import {
  ChevronLeft,
  ChevronRight,
  Layers,
  MessageSquareText,
  Pause,
  Pin,
  Play,
  ScanText,
  Sparkles,
  Square
} from 'lucide-react'
import { Badge } from '@openai/apps-sdk-ui/components/Badge'
import { Button } from '@openai/apps-sdk-ui/components/Button'
import { EmptyMessage } from '@openai/apps-sdk-ui/components/EmptyMessage'
import { Input } from '@openai/apps-sdk-ui/components/Input'
import { ShimmerText } from '@openai/apps-sdk-ui/components/ShimmerText'
import { Switch } from '@openai/apps-sdk-ui/components/Switch'
import type { Card, LiveState } from '../../../shared/types'
import { CardView } from '../components/CardView'
import { StartForm } from '../components/StartForm'
import { Transcript } from '../components/Transcript'
import { IconButton, Kbd, LiveDot, Page, Tip } from '../components/ui'
import { clock, go, timeOfDay, useHotkey, useNow } from '../lib'
import { call, useStore } from '../store'

export function Live(): ReactNode {
  const live = useStore((s) => s.live)
  if (!live || (live.session !== 'live' && live.session !== 'paused'))
    return (
      <Page title="Live" subtitle="No session running">
        <StartForm />
      </Page>
    )
  return <LiveSession live={live} />
}

export const cardPrompt = (c: Card): string =>
  c.sections[c.sections.length - 1]?.prompt ||
  c.sections[0]?.say ||
  (c.status === 'error' ? 'Failed card' : 'New card')

function LiveSession({ live }: { live: LiveState }): ReactNode {
  const now = useNow()
  const paused = live.session === 'paused'
  const active = live.cards.find((c) => c.id === live.activeCardId)
  const queued = live.cards.find((c) => c.id === live.queuedCardId)
  const ask = useHotkey('ask')

  return (
    <div className="flex h-full min-w-0 flex-col">
      <header className="drag flex h-[52px] shrink-0 items-center gap-3 border-b border-subtle px-5">
        <LiveDot paused={paused} />
        <h1 className="no-drag min-w-0 truncate heading-xs">{live.title}</h1>
        <span className="text-sm whitespace-nowrap text-secondary tabular-nums">
          {live.startedAt ? clock(now - live.startedAt) : ''}
        </span>
        {paused && <Badge color="warning">Paused</Badge>}
        <div className="ml-auto flex shrink-0 items-center gap-1.5 text-sm whitespace-nowrap text-secondary">
          {live.thinking ? (
            <ShimmerText as="span">Thinking…</ShimmerText>
          ) : paused ? (
            'Not listening'
          ) : (
            'Listening'
          )}
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <section
          className="relative flex min-w-0 flex-1 flex-col border-r border-subtle"
          aria-label="Transcript"
        >
          <Transcript
            utterances={live.utterances}
            partial={live.partial}
            empty={
              <EmptyMessage fill="absolute">
                <EmptyMessage.Icon>
                  <MessageSquareText />
                </EmptyMessage.Icon>
                <EmptyMessage.Title>Waiting for the conversation</EmptyMessage.Title>
                <EmptyMessage.Description>
                  What you say appears on the right, what they say on the left, a second or two
                  after it is spoken.
                </EmptyMessage.Description>
              </EmptyMessage>
            }
          />
        </section>
        <CardPanel live={live} active={active} queued={queued} />
      </div>

      <footer className="flex shrink-0 items-center gap-2 border-t border-subtle px-4 py-2.5">
        <AskBox placeholder={`Ask anything, or press ${ask} for help with what was just said`} />
        <IconButton
          label="Solve what's on screen"
          hotkey="screen"
          onClick={() => call('cue:screen')}
          size="md"
        >
          <ScanText />
        </IconButton>
        <Tip
          label={
            live.autoCue
              ? 'Cards appear by themselves when they ask something'
              : 'Cards only appear when you ask'
          }
        >
          <Switch
            className="mx-2 text-sm whitespace-nowrap"
            label="Auto cards"
            checked={live.autoCue}
            onCheckedChange={(on) => call('cue:setAuto', on)}
          />
        </Tip>
        <Tip label={paused ? 'Resume listening' : 'Pause listening'} hotkey="toggleListening">
          <Button color="secondary" variant="soft" onClick={() => call('session:pause', !paused)}>
            {paused ? <Play /> : <Pause />}
            {paused ? 'Resume' : 'Pause'}
          </Button>
        </Tip>
        <Tip label="Stop listening, save, and write a recap">
          <Button
            color="danger"
            variant="soft"
            onClick={() => {
              const id = live.sessionId
              call('session:end')
              if (id) go(`session/${id}`)
            }}
          >
            <Square className="fill-current" />
            End
          </Button>
        </Tip>
      </footer>
    </div>
  )
}

export function AskBox({
  placeholder,
  autoFocus,
  onDone
}: {
  placeholder: string
  autoFocus?: boolean
  onDone?: () => void
}): ReactNode {
  const [q, setQ] = useState('')
  return (
    <Input
      className="flex-1"
      autoFocus={autoFocus}
      placeholder={placeholder}
      value={q}
      onChange={(e) => setQ(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          call('cue:ask', q.trim())
          setQ('')
          onDone?.()
        }
        if (e.key === 'Escape') onDone?.()
      }}
      startAdornment={<Sparkles className="size-4 text-tertiary" />}
      aria-label="Ask"
    />
  )
}

function CardPanel({
  live,
  active,
  queued
}: {
  live: LiveState
  active?: Card
  queued?: Card
}): ReactNode {
  const index = active ? live.cards.indexOf(active) : -1
  const shown = live.cards.filter((c) => c.id !== live.queuedCardId)
  const history = [...shown].reverse().filter((c) => c.id !== active?.id)
  const askKey = useHotkey('ask')
  const screenKey = useHotkey('screen')
  const nextKey = useHotkey('nextCard')

  return (
    <section
      className="flex w-[46%] max-w-[560px] min-w-[360px] flex-col bg-surface-secondary"
      aria-label="Cards"
    >
      <div className="flex h-11 shrink-0 items-center gap-1 px-4">
        <span className="text-xs font-medium text-secondary">
          {active ? `Card ${index + 1} of ${shown.length}` : 'Cards'}
        </span>
        <div className="ml-auto flex items-center">
          <IconButton
            label="Previous card"
            hotkey="prevCard"
            onClick={() => call('cue:step', -1)}
            disabledReason={index <= 0 && 'This is the first card'}
          >
            <ChevronLeft />
          </IconButton>
          <IconButton
            label="Next card"
            hotkey="nextCard"
            onClick={() => call('cue:step', 1)}
            disabledReason={!queued && index >= shown.length - 1 && 'This is the newest card'}
          >
            <ChevronRight />
          </IconButton>
          <IconButton
            label={live.pinned ? 'Unpin card' : 'Pin card (new cards wait in the queue)'}
            hotkey="pin"
            selected={live.pinned}
            onClick={() => call('cue:pin', !live.pinned)}
          >
            <Pin />
          </IconButton>
          <IconButton
            label="Go deeper on this card"
            hotkey="deeper"
            onClick={() => call('cue:deeper')}
            disabledReason={!active && 'No card to expand yet'}
          >
            <Layers />
          </IconButton>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
        <div className="rounded-xl border border-default bg-surface p-5 shadow-sm">
          {active ? (
            <CardView key={active.id} card={active} scale={1.1} detailOpen />
          ) : live.thinking ? (
            <ShimmerText className="text-secondary">Working out what to say…</ShimmerText>
          ) : (
            <div className="py-6 text-center text-sm text-secondary">
              <p className="font-medium text-default">
                Cards appear here when they ask you something
              </p>
              <p className="mt-1.5">
                Press <Kbd>{askKey}</Kbd> for help with what was just said, or{' '}
                <Kbd>{screenKey}</Kbd> to solve what's on screen.
              </p>
            </div>
          )}
        </div>
        {queued && (
          <button
            onClick={() => call('cue:show', queued.id)}
            className="mt-2 flex w-full items-center gap-2 rounded-lg border border-default bg-surface px-3 py-2 text-left text-sm hover:bg-[var(--alpha-04)]"
          >
            <span className="font-medium text-accent-text">Next</span>
            <span className="min-w-0 flex-1 truncate">{cardPrompt(queued)}</span>
            <Kbd>{nextKey}</Kbd>
          </button>
        )}
        {history.length > 0 && (
          <>
            <h3 className="mt-5 mb-1.5 px-1 text-xs font-medium text-tertiary">Earlier cards</h3>
            <ul className="space-y-0.5">
              {history.map((c) => (
                <li key={c.id}>
                  <button
                    onClick={() => call('cue:show', c.id)}
                    className="flex w-full items-center gap-3 rounded-lg px-2 py-1.5 text-left text-sm text-secondary hover:bg-[var(--alpha-05)] hover:text-default"
                  >
                    <span className="min-w-0 flex-1 truncate">{cardPrompt(c)}</span>
                    {c.sections.length > 1 && (
                      <span className="text-xs text-tertiary">{c.sections.length} parts</span>
                    )}
                    <span className="text-xs text-tertiary tabular-nums">
                      {timeOfDay(c.createdAt)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </section>
  )
}
