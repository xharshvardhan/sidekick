import type { ReactNode } from 'react'
import { AlertTriangle, History, House, PictureInPicture2, Radio, Settings } from 'lucide-react'
import { Button } from '@openai/apps-sdk-ui/components/Button'
import type { AudioHealth } from '../../../shared/types'
import { sk } from '../bridge'
import { clock, go, useNow } from '../lib'
import { useStore } from '../store'
import { LiveDot, Tip } from './ui'

const NAV = [
  { id: 'home', label: 'Home', Icon: House },
  { id: 'live', label: 'Live', Icon: Radio },
  { id: 'history', label: 'History', Icon: History },
  { id: 'settings', label: 'Settings', Icon: Settings }
] as const

export function Sidebar({ route }: { route: string }): ReactNode {
  const live = useStore((s) => s.live)
  const active = live?.session === 'live' || live?.session === 'paused'
  const current = route === 'session' ? 'history' : route === 'setup' ? 'settings' : route

  return (
    <aside className="flex w-[216px] shrink-0 flex-col border-r border-subtle bg-sidebar">
      {/* Traffic lights live here (hiddenInset). */}
      <div className="drag h-[52px] shrink-0" />
      <nav className="flex flex-col gap-0.5 px-3">
        {NAV.map(({ id, label, Icon }) => (
          <button
            key={id}
            onClick={() => go(id)}
            aria-current={current === id ? 'page' : undefined}
            className={`flex h-8 items-center gap-2.5 rounded-lg px-2.5 text-sm ${
              current === id
                ? 'bg-[var(--alpha-08)] font-medium text-default'
                : 'text-secondary hover:bg-[var(--alpha-05)] hover:text-default'
            }`}
          >
            <Icon className="size-4" strokeWidth={1.8} />
            <span className="flex-1 text-left">{label}</span>
            {id === 'live' && active && live?.startedAt && (
              <span className="flex items-center gap-1.5 text-xs text-secondary tabular-nums">
                <LiveDot paused={live.session === 'paused'} />
                <Timer since={live.startedAt} />
              </span>
            )}
          </button>
        ))}
      </nav>
      <div className="mt-auto flex flex-col gap-3 border-t border-subtle p-3">
        <AudioStatus audio={live?.audio} active={active} />
        <Tip label="Hide this window and keep only the overlay" hotkey="toggleMode" side="top">
          <Button
            color="secondary"
            variant="soft"
            size="sm"
            block
            onClick={() => sk().invoke('window:setMode', 'overlay')}
          >
            <PictureInPicture2 />
            Overlay only
          </Button>
        </Tip>
      </div>
    </aside>
  )
}

function Timer({ since }: { since: number }): ReactNode {
  const now = useNow()
  return <>{clock(now - since)}</>
}

const STATUS: Record<AudioHealth['mic'], [string, string]> = {
  ok: ['Listening', 'bg-accent'],
  starting: ['Starting…', 'bg-[var(--color-text-tertiary)]'],
  denied: ['Permission needed', 'bg-[var(--color-text-danger)]'],
  error: ['Error', 'bg-[var(--color-text-danger)]'],
  off: ['Off', 'bg-[var(--alpha-20)]']
}

function AudioStatus({ audio, active }: { audio?: AudioHealth; active: boolean }): ReactNode {
  const rows: [string, AudioHealth['mic']][] = [
    ['Microphone', audio?.mic ?? 'off'],
    ['Call audio', audio?.system ?? 'off']
  ]
  return (
    <div className="px-1 text-xs">
      <div className="mb-1.5 font-medium text-tertiary">Audio</div>
      {!active && !audio?.message ? (
        <p className="text-secondary">Off until a session starts</p>
      ) : (
        <ul className="space-y-1">
          {rows.map(([label, st]) => (
            <li key={label} className="flex items-center gap-2">
              <span className={`size-1.5 rounded-full ${STATUS[st][1]}`} />
              <span className="flex-1 text-secondary">{label}</span>
              <span className={st === 'denied' || st === 'error' ? 'text-danger' : 'text-tertiary'}>
                {STATUS[st][0]}
              </span>
            </li>
          ))}
        </ul>
      )}
      {audio?.message && (
        <p className="mt-2 flex items-start gap-1.5 text-warning">
          <AlertTriangle className="mt-px size-3.5 shrink-0" />
          {audio.message}
        </p>
      )}
    </div>
  )
}
