import { useEffect, useState, type ReactNode } from 'react'
import { AudioLines, Check, CircleAlert, Cloud, Mic, MonitorSpeaker, Volume2 } from 'lucide-react'
import { Button } from '@openai/apps-sdk-ui/components/Button'
import { LoadingIndicator } from '@openai/apps-sdk-ui/components/Indicator'
import type { Permissions } from '../../../shared/types'
import { sk } from '../bridge'
import { LevelMeter, Panel, Tip } from '../components/ui'
import { go } from '../lib'
import { call, errText, useStore } from '../store'

type CheckResult = { state: 'ok' | 'bad' | 'checking'; detail: string }

function playTestSound(): void {
  const ctx = new AudioContext()
  const t = ctx.currentTime
  ;[523.25, 659.25, 783.99].forEach((f, i) => {
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.frequency.value = f
    gain.gain.setValueAtTime(0, t + i * 0.25)
    gain.gain.linearRampToValueAtTime(0.25, t + i * 0.25 + 0.03)
    gain.gain.exponentialRampToValueAtTime(0.001, t + i * 0.25 + 0.9)
    osc.connect(gain).connect(ctx.destination)
    osc.start(t + i * 0.25)
    osc.stop(t + i * 0.25 + 1)
  })
  setTimeout(() => ctx.close(), 2000)
}

export function Setup({ firstRun }: { firstRun: boolean }): ReactNode {
  const [perm, setPerm] = useState<Permissions | null>(null)
  const [error, setError] = useState('')
  const levels = useStore((s) => s.levels)

  useEffect(() => {
    let alive = true
    const check = (): void => {
      sk()
        .invoke('permissions:check')
        .then((p) => alive && (setPerm(p), setError('')))
        .catch((e) => alive && setError(errText(e)))
    }
    check()
    const id = setInterval(check, 2500)
    sk()
      .invoke('audio:test', true)
      .catch((e) => setError(`Couldn't start audio capture: ${errText(e)}`))
    return () => {
      alive = false
      clearInterval(id)
      void sk()
        .invoke('audio:test', false)
        .catch(() => {})
    }
  }, [])

  const mic: CheckResult = !perm
    ? { state: 'checking', detail: 'Checking…' }
    : perm.microphone === 'granted'
      ? { state: 'ok', detail: 'Sidekick can hear you.' }
      : {
          state: 'bad',
          detail: 'Needed to transcribe what you say. Allow Sidekick in System Settings.'
        }
  const screen: CheckResult = !perm
    ? { state: 'checking', detail: 'Checking…' }
    : perm.screen === 'granted'
      ? { state: 'ok', detail: 'Sidekick can hear the call and read your screen when you ask.' }
      : {
          state: 'bad',
          detail:
            'Needed to hear the other side of the call. After allowing it, macOS may ask you to quit and reopen Sidekick.'
        }
  const vertex: CheckResult = !perm
    ? { state: 'checking', detail: 'Checking…' }
    : { state: perm.vertex.ok ? 'ok' : 'bad', detail: perm.vertex.message }
  const allOk = [mic, screen, vertex].every((c) => c.state === 'ok')

  const finish = async (): Promise<void> => {
    await useStore.getState().saveSettings({ onboarded: true })
    go('home')
  }

  return (
    <div className="flex h-full flex-col">
      <div className="drag h-[52px] shrink-0" />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-2xl px-8 pb-8">
          <h1 className="heading-lg">{firstRun ? 'Set up Sidekick' : 'Setup checks'}</h1>
          <p className="mt-1.5 text-secondary">
            Sidekick needs to hear both sides of your call and reach the AI model. These update live
            as you fix them.
          </p>

          <Panel className="mt-6 divide-y divide-[var(--color-border-subtle)]">
            <CheckRow
              icon={<Mic />}
              title="Microphone"
              check={mic}
              fix={() => call('permissions:open', 'microphone')}
              fixLabel="Open System Settings"
            />
            <CheckRow
              icon={<MonitorSpeaker />}
              title="Screen & System Audio Recording"
              check={screen}
              fix={() => call('permissions:open', 'screen')}
              fixLabel="Open System Settings"
            />
            <CheckRow
              icon={<Cloud />}
              title="Vertex connection"
              check={vertex}
              fix={() => go('settings')}
              fixLabel="Edit Vertex settings"
            />
          </Panel>
          {error && <p className="mt-3 text-sm text-danger">{error}</p>}

          <Panel className="mt-4 p-5">
            <div className="flex items-start gap-3">
              <AudioLines className="mt-0.5 size-5 text-secondary" />
              <div className="flex-1">
                <h2 className="text-sm font-medium">Level check</h2>
                <p className="mt-0.5 text-sm text-secondary">
                  Say something to move "You". Play the test sound to move "Them", the way a call
                  would.
                </p>
              </div>
            </div>
            <div className="mt-4 grid gap-2.5">
              <LevelMeter label="You" level={levels.you} />
              <LevelMeter label="Them" level={levels.them} />
            </div>
            <Button
              className="mt-4"
              color="secondary"
              variant="soft"
              size="sm"
              onClick={playTestSound}
            >
              <Volume2 />
              Play test sound
            </Button>
          </Panel>
        </div>
      </div>
      <div className="flex shrink-0 items-center justify-end gap-3 border-t border-subtle px-8 py-3">
        <span className="mr-auto text-sm text-secondary">
          {allOk ? 'All checks pass.' : 'Finish unlocks when all three checks pass.'}
        </span>
        {firstRun && (
          <Button color="secondary" variant="ghost" onClick={finish}>
            Skip for now
          </Button>
        )}
        <Tip label={allOk ? 'Everything is ready' : 'Fix the checks above first'}>
          <Button
            color="success"
            disabled={firstRun && !allOk}
            onClick={firstRun ? finish : () => go('settings')}
          >
            {firstRun ? 'Finish setup' : 'Done'}
          </Button>
        </Tip>
      </div>
    </div>
  )
}

function CheckRow({
  icon,
  title,
  check,
  fix,
  fixLabel
}: {
  icon: ReactNode
  title: string
  check: CheckResult
  fix: () => void
  fixLabel: string
}): ReactNode {
  return (
    <div className="flex items-start gap-3.5 px-5 py-4">
      <span className="mt-0.5 text-secondary [&_svg]:size-5">{icon}</span>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">{title}</div>
        <p
          className={`selectable mt-0.5 text-sm ${check.state === 'bad' ? 'text-secondary' : 'text-tertiary'}`}
        >
          {check.detail}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2 pt-0.5">
        {check.state === 'checking' && <LoadingIndicator size={16} />}
        {check.state === 'ok' && (
          <span className="flex items-center gap-1 text-sm font-medium text-success">
            <Check className="size-4" /> Ready
          </span>
        )}
        {check.state === 'bad' && (
          <>
            <CircleAlert className="size-4 text-danger" />
            <Button color="secondary" variant="outline" size="sm" onClick={fix}>
              {fixLabel}
            </Button>
          </>
        )}
      </div>
    </div>
  )
}
