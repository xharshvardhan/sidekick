import { useEffect, useState, type ReactNode } from 'react'
import {
  AppWindow,
  CircleAlert,
  MessageCircleQuestion,
  Mic,
  Pin,
  TriangleAlert,
  Volume2
} from 'lucide-react'
import { Button } from '@openai/apps-sdk-ui/components/Button'
import { ShimmerText } from '@openai/apps-sdk-ui/components/ShimmerText'
import type { LiveState } from '../../../shared/types'
import { demoBackdrop } from '../bridge'
import { CardView } from '../components/CardView'
import { IconButton, Kbd, LiveDot, MiniLevel, Tip } from '../components/ui'
import { clock, toAccelerator, useHotkey, useNow } from '../lib'
import { call, useStore } from '../store'
import { AskBox, cardPrompt } from './Live'

export function Overlay(): ReactNode {
  const live = useStore((s) => s.live)
  const overlay = useStore((s) => s.settings?.overlay)
  const askAcc = useStore((s) => s.settings?.hotkeys.find((h) => h.id === 'ask')?.accelerator)
  const [asking, setAsking] = useState(false)
  // errors reach this window as toasts (kept ~8 s by the store); the overlay shows the latest one inline
  const error = useStore((s) => s.toasts.findLast((t) => t.kind === 'error'))

  useEffect(() => {
    document.documentElement.classList.add('overlay')
    const onKey = (e: KeyboardEvent): void => {
      if (askAcc && toAccelerator(e) === askAcc) {
        e.preventDefault()
        setAsking(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [askAcc])

  const scale = overlay?.fontScale ?? 1

  return (
    <div className="relative h-full overflow-hidden">
      {demoBackdrop && <TestBackdrop kind={demoBackdrop} />}
      {/* Tinted layer over the native HUD vibrancy: keeps contrast over any backdrop. */}
      <div
        className="absolute inset-0 rounded-[12px] border border-[var(--alpha-10)]"
        style={{
          background: `rgb(var(--hud-tint) / var(--hud-alpha))`,
          // In the app the page has nothing behind it (native HUD vibrancy does the blur); this only
          // matters for the demo backdrop, where it stands in for that vibrancy.
          backdropFilter: 'blur(30px) saturate(1.4)'
        }}
      />
      <div className="relative flex h-full flex-col">
        {live ? (
          <>
            <Header live={live} onAsk={() => setAsking(!asking)} asking={asking} />
            {live.audio.message && (
              <div className="flex h-6 shrink-0 items-center gap-1.5 border-b border-subtle px-3.5 text-xs text-warning">
                <TriangleAlert className="size-3.5 shrink-0" />
                <span className="truncate">{live.audio.message}</span>
              </div>
            )}
            {error && !live.audio.message?.includes(error.text) && (
              <div
                role="alert"
                title={error.text}
                className="flex h-6 shrink-0 items-center gap-1.5 border-b border-subtle px-3.5 text-xs text-danger"
              >
                <CircleAlert className="size-3.5 shrink-0" />
                <span className="selectable truncate">{error.text}</span>
              </div>
            )}
            <Body live={live} scale={scale} />
            <Queued live={live} />
            {asking && (
              <div className="no-drag shrink-0 border-t border-subtle px-2.5 py-2">
                <AskBox
                  autoFocus
                  placeholder="Ask anything, or press Enter for help with what was just said"
                  onDone={() => setAsking(false)}
                />
              </div>
            )}
          </>
        ) : (
          <div className="drag flex-1" />
        )}
      </div>
    </div>
  )
}

function Header({
  live,
  onAsk,
  asking
}: {
  live: LiveState
  onAsk: () => void
  asking: boolean
}): ReactNode {
  const now = useNow()
  const levels = useStore((s) => s.levels)
  const prev = useHotkey('prevCard')
  const next = useHotkey('nextCard')
  const on = live.session === 'live' || live.session === 'paused'
  const shown = live.cards.filter((c) => c.id !== live.queuedCardId)
  const index = shown.findIndex((c) => c.id === live.activeCardId)
  const status = !on
    ? 'No session'
    : live.session === 'paused'
      ? 'Paused'
      : live.thinking
        ? 'Thinking…'
        : 'Listening'

  return (
    <header className="drag flex h-7 shrink-0 items-center gap-2 border-b border-subtle pr-1 pl-3.5 text-xs text-secondary">
      {on && <LiveDot paused={live.session === 'paused'} />}
      {on && live.startedAt && (
        <span className="font-medium text-default tabular-nums">{clock(now - live.startedAt)}</span>
      )}
      {on && (
        <span className="flex items-center gap-2 px-1">
          <MiniLevel label="You" icon={<Mic />} level={levels.you} />
          <MiniLevel label="Them" icon={<Volume2 />} level={levels.them} />
        </span>
      )}
      {live.thinking && on ? <ShimmerText as="span">{status}</ShimmerText> : <span>{status}</span>}
      <div className="ml-auto flex items-center">
        {index >= 0 && (
          <Tip
            label={
              <span className="whitespace-nowrap">
                Card {index + 1} of {shown.length} · {prev} previous · {next} next
              </span>
            }
            side="bottom"
          >
            <span className="px-1.5 tabular-nums">
              {index + 1}/{shown.length}
            </span>
          </Tip>
        )}
        <IconButton
          label="Ask"
          hotkey="ask"
          onClick={onAsk}
          selected={asking}
          size="2xs"
          side="bottom"
        >
          <MessageCircleQuestion />
        </IconButton>
        <IconButton
          label={live.pinned ? 'Unpin card' : 'Pin card'}
          hotkey="pin"
          selected={live.pinned}
          onClick={() => call('cue:pin', !live.pinned)}
          size="2xs"
          side="bottom"
        >
          <Pin />
        </IconButton>
        <IconButton
          label="Switch to the app window"
          hotkey="toggleMode"
          onClick={() => call('window:setMode', 'app')}
          size="2xs"
          side="bottom"
        >
          <AppWindow />
        </IconButton>
      </div>
    </header>
  )
}

function Body({ live, scale }: { live: LiveState; scale: number }): ReactNode {
  const active = live.cards.find((c) => c.id === live.activeCardId)
  const ask = useHotkey('ask')
  const screen = useHotkey('screen')
  const lastThem = [...live.utterances].reverse().find((u) => u.speaker === 'them')
  const on = live.session === 'live' || live.session === 'paused'

  return (
    <div className="no-drag min-h-0 flex-1 overflow-y-auto px-4 pt-3 pb-3">
      {active ? (
        <CardView key={active.id} card={active} scale={scale} />
      ) : !on ? (
        <div className="flex flex-col items-start gap-3">
          <p className="text-sm text-secondary">
            Start a session in Sidekick and cards will show up here.
          </p>
          <Button color="primary" size="sm" onClick={() => call('window:setMode', 'app')}>
            <AppWindow />
            Open Sidekick
          </Button>
        </div>
      ) : (
        <div style={{ fontSize: `${14 * scale}px` }}>
          <div className="text-[0.75em] font-semibold tracking-wider text-tertiary uppercase">
            They said
            {live.partial.them && (
              <span className="font-normal tracking-normal normal-case"> · speaking now…</span>
            )}
          </div>
          <p className="selectable mt-1 truncate text-default">
            {lastThem ? (
              caption(lastThem.text)
            ) : (
              <span className="text-secondary">
                Nothing yet. Cards appear when they ask you something.
              </span>
            )}
          </p>
          <div className="mt-4 flex flex-wrap gap-x-5 gap-y-2 text-[0.9em] text-secondary">
            <span className="flex items-center gap-2">
              <Kbd>{ask}</Kbd> Help with what was just said
            </span>
            <span className="flex items-center gap-2">
              <Kbd>{screen}</Kbd> Solve what's on screen
            </span>
          </div>
        </div>
      )}
    </div>
  )
}

/** A live caption reads like subtitles: keep the end of a long utterance, not its start. */
function caption(text: string, max = 80): string {
  if (text.length <= max) return text
  const tail = text.slice(-max)
  return `…${tail.slice(tail.indexOf(' ') + 1)}`
}

function Queued({ live }: { live: LiveState }): ReactNode {
  const queued = live.cards.find((c) => c.id === live.queuedCardId)
  const next = useHotkey('nextCard')
  if (!queued) return null
  return (
    <button
      onClick={() => call('cue:step', 1)}
      className="no-drag flex h-8 shrink-0 items-center gap-2 border-t border-subtle px-3.5 text-left text-xs hover:bg-[var(--alpha-04)]"
    >
      <span className="size-1.5 shrink-0 rounded-full bg-accent" />
      <span className="font-semibold text-secondary">Next</span>
      <span className="min-w-0 flex-1 truncate text-default">{cardPrompt(queued)}</span>
      <Kbd>{next}</Kbd>
    </button>
  )
}

/** Demo/screenshot only: a busy backdrop standing in for whatever is behind the overlay. */
function TestBackdrop({ kind }: { kind: string }): ReactNode {
  const dark = kind === 'dark'
  return (
    <div
      className="absolute inset-0 overflow-hidden p-4 font-sans text-[22px] leading-tight font-semibold"
      style={{ background: dark ? '#1b2633' : '#f4efe6', color: dark ? '#e8eef5' : '#1d1d1f' }}
    >
      <div
        className="absolute top-6 right-8 size-40 rounded-full"
        style={{ background: dark ? '#4a6a8a' : '#e0b070' }}
      />
      <div
        className="absolute bottom-0 left-10 h-28 w-64 rounded-t-3xl"
        style={{ background: dark ? '#7a4b3a' : '#7aa0c8' }}
      />
      {Array.from({ length: 10 }, (_, i) => (
        <p key={i}>Shared screen text behind the overlay, line {i + 1}</p>
      ))}
    </div>
  )
}
