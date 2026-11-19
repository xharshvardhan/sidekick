import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Check, CircleAlert } from 'lucide-react'
import { Button } from '@openai/apps-sdk-ui/components/Button'
import { Input } from '@openai/apps-sdk-ui/components/Input'
import { SegmentedControl } from '@openai/apps-sdk-ui/components/SegmentedControl'
import { Select } from '@openai/apps-sdk-ui/components/Select'
import { Slider } from '@openai/apps-sdk-ui/components/Slider'
import { Switch } from '@openai/apps-sdk-ui/components/Switch'
import { Textarea } from '@openai/apps-sdk-ui/components/Textarea'
import type { DeepPartial, Hotkey, Permissions, Settings as SettingsT } from '../../../shared/types'
import { sk } from '../bridge'
import { Kbd, LevelMeter, Page, Panel } from '../components/ui'
import { go, keycaps, toAccelerator } from '../lib'
import { errText, useStore } from '../store'

/** Local draft that saves after the user pauses typing (and on unmount). */
function useDraft<T>(value: T, save: (v: T) => void, delay = 600): [T, (v: T) => void] {
  const [draft, setDraft] = useState(value)
  const pending = useRef<{ v: T; t: ReturnType<typeof setTimeout> } | null>(null)
  const saveRef = useRef(save)
  saveRef.current = save
  useEffect(
    () => () => {
      if (pending.current) {
        clearTimeout(pending.current.t)
        saveRef.current(pending.current.v)
      }
    },
    []
  )
  return [
    draft,
    (v) => {
      setDraft(v)
      if (pending.current) clearTimeout(pending.current.t)
      pending.current = {
        v,
        t: setTimeout(() => ((pending.current = null), saveRef.current(v)), delay)
      }
    }
  ]
}

const LANGUAGES = [
  { value: '', label: 'Detect automatically' },
  { value: 'en', label: 'English' },
  { value: 'hi', label: 'Hindi' },
  { value: 'es', label: 'Spanish' },
  { value: 'fr', label: 'French' },
  { value: 'de', label: 'German' },
  { value: 'pt', label: 'Portuguese' },
  { value: 'ja', label: 'Japanese' }
]

export function Settings(): ReactNode {
  const settings = useStore((s) => s.settings)
  const savedAt = useStore((s) => s.savedAt)
  const [showSaved, setShowSaved] = useState(false)
  useEffect(() => {
    if (!savedAt) return
    setShowSaved(true)
    const t = setTimeout(() => setShowSaved(false), 1800)
    return () => clearTimeout(t)
  }, [savedAt])

  return (
    <Page
      title="Settings"
      subtitle={
        <span
          className={`flex items-center gap-1 transition-opacity ${showSaved ? 'opacity-100' : 'opacity-0'}`}
        >
          <Check className="size-3.5" /> Saved
        </span>
      }
    >
      {settings ? (
        <SettingsForm s={settings} />
      ) : (
        <p className="text-sm text-secondary">Loading settings…</p>
      )}
    </Page>
  )
}

function SettingsForm({ s }: { s: SettingsT }): ReactNode {
  const save = useStore((st) => st.saveSettings)
  const set = (patch: DeepPartial<SettingsT>): void => void save(patch)
  return (
    <div className="grid gap-6">
      <Group
        title="Profile"
        bare
        hint="Used in every session so answers sound like you. Paste your resume summary, role, and how you like to talk."
      >
        <DraftTextarea value={s.profile} onSave={(profile) => set({ profile })} />
      </Group>

      <Group title="Answers">
        <Row
          label="Auto cards"
          hint="Show a card by itself when they ask you something. Off means cards only appear when you ask."
        >
          <Switch checked={s.autoCue} onCheckedChange={(autoCue) => set({ autoCue })} />
        </Row>
        <Row
          label="Answer style"
          hint="Brief keeps cards to a line and a few points; Standard adds more detail."
        >
          <SegmentedControl<SettingsT['answerStyle']>
            aria-label="Answer style"
            value={s.answerStyle}
            onChange={(answerStyle) => set({ answerStyle })}
            size="sm"
          >
            <SegmentedControl.Option value="brief">Brief</SegmentedControl.Option>
            <SegmentedControl.Option value="standard">Standard</SegmentedControl.Option>
          </SegmentedControl>
        </Row>
        <Row label="Language" hint="The language spoken on your calls.">
          <div className="w-52">
            <Select
              options={LANGUAGES}
              value={s.language}
              onChange={(o) => set({ language: o.value })}
              size="sm"
            />
          </div>
        </Row>
        <Row label="Appearance">
          <SegmentedControl<SettingsT['theme']>
            aria-label="Appearance"
            value={s.theme}
            onChange={(theme) => set({ theme })}
            size="sm"
          >
            <SegmentedControl.Option value="system">System</SegmentedControl.Option>
            <SegmentedControl.Option value="light">Light</SegmentedControl.Option>
            <SegmentedControl.Option value="dark">Dark</SegmentedControl.Option>
          </SegmentedControl>
        </Row>
      </Group>

      <Group title="Overlay" hint="The small window that floats over your call.">
        <Row label="Show when a session starts">
          <Switch
            checked={s.overlay.showOnStart}
            onCheckedChange={(showOnStart) => set({ overlay: { showOnStart } })}
          />
        </Row>
        <Row label="Opacity">
          <DraftSlider
            value={s.overlay.opacity}
            min={0.6}
            max={1}
            onSave={(opacity) => set({ overlay: { opacity } })}
          />
        </Row>
        <Row label="Text size">
          <DraftSlider
            value={s.overlay.fontScale}
            min={0.9}
            max={1.3}
            onSave={(fontScale) => set({ overlay: { fontScale } })}
          />
        </Row>
        <Row
          label="Hide from screen sharing"
          hint="Asks macOS to leave the overlay out of screen shares and recordings. Some capture tools ignore this, so check before relying on it."
        >
          <Switch
            checked={s.overlay.hideFromScreenShare}
            onCheckedChange={(hideFromScreenShare) => set({ overlay: { hideFromScreenShare } })}
          />
        </Row>
      </Group>

      <Group title="Audio">
        <Row
          label="Echo cancellation"
          hint="Removes your speakers from the microphone so their voice isn't transcribed as yours. Turn off if you use headphones and your voice sounds clipped."
        >
          <Switch
            checked={s.echoCancellation}
            onCheckedChange={(echoCancellation) => set({ echoCancellation })}
          />
        </Row>
        <MeterTest />
      </Group>

      <Group
        title="Hotkeys"
        hint="Work everywhere, even while the call app is focused. Click a shortcut, then press the new keys."
      >
        <HotkeyList hotkeys={s.hotkeys} onSave={(hotkeys) => set({ hotkeys })} />
      </Group>

      <Group title="Models">
        <Row label="Transcription">
          <DraftInput value={s.models.stt} onSave={(stt) => set({ models: { stt } })} />
        </Row>
        <Row label="Cards" hint="Fast model for the first line of every card.">
          <DraftInput value={s.models.cue} onSave={(cue) => set({ models: { cue } })} />
        </Row>
        <Row label="Deeper answers and recaps">
          <DraftInput value={s.models.deep} onSave={(deep) => set({ models: { deep } })} />
        </Row>
      </Group>

      <Group title="Vertex AI">
        <Row label="Project">
          <DraftInput
            value={s.vertex.project}
            placeholder="my-gcp-project"
            onSave={(project) => set({ vertex: { project } })}
          />
        </Row>
        <Row label="Location">
          <DraftInput
            value={s.vertex.location}
            placeholder="global"
            onSave={(location) => set({ vertex: { location } })}
          />
        </Row>
        <Row label="Service account key" hint="Path to the JSON key file.">
          <DraftInput
            value={s.vertex.credentialsPath}
            placeholder="/Users/you/key.json"
            onSave={(credentialsPath) => set({ vertex: { credentialsPath } })}
          />
        </Row>
        <VertexTest />
      </Group>

      <Group
        title="Setup checks"
        hint="Microphone and screen recording permissions, call audio, and the Vertex connection."
      >
        <div className="px-5 py-4">
          <Button color="secondary" variant="soft" size="sm" onClick={() => go('setup')}>
            Run setup checks
          </Button>
        </div>
      </Group>
    </div>
  )
}

function Group({
  title,
  hint,
  bare,
  children
}: {
  title: string
  hint?: string
  bare?: boolean
  children: ReactNode
}): ReactNode {
  return (
    <section>
      <h2 className="heading-xs">{title}</h2>
      {hint && <p className="mt-1 text-sm text-secondary">{hint}</p>}
      {bare ? (
        <div className="mt-3">{children}</div>
      ) : (
        <Panel className="mt-3 divide-y divide-[var(--color-border-subtle)]">{children}</Panel>
      )}
    </section>
  )
}

function Row({
  label,
  hint,
  children
}: {
  label: string
  hint?: string
  children: ReactNode
}): ReactNode {
  return (
    <div className="flex items-center gap-6 px-5 py-3.5">
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">{label}</div>
        {hint && <div className="mt-0.5 text-xs leading-relaxed text-secondary">{hint}</div>}
      </div>
      <div className="flex shrink-0 justify-end">{children}</div>
    </div>
  )
}

function DraftInput({
  value,
  onSave,
  placeholder
}: {
  value: string
  onSave: (v: string) => void
  placeholder?: string
}): ReactNode {
  const [v, setV] = useDraft(value, onSave)
  return (
    <Input
      className="w-72"
      size="sm"
      value={v}
      placeholder={placeholder}
      onChange={(e) => setV(e.target.value)}
    />
  )
}

function DraftTextarea({
  value,
  onSave
}: {
  value: string
  onSave: (v: string) => void
}): ReactNode {
  const [v, setV] = useDraft(value, onSave)
  return (
    <Textarea
      rows={6}
      autoResize
      maxRows={14}
      value={v}
      onChange={(e) => setV(e.target.value)}
      placeholder="e.g. Senior backend engineer, 6 years. Led the payments settlement rewrite at Ledgerly (batch to < 2 min). Prefer short, concrete answers with numbers."
      aria-label="About me"
    />
  )
}

function DraftSlider({
  value,
  min,
  max,
  onSave
}: {
  value: number
  min: number
  max: number
  onSave: (v: number) => void
}): ReactNode {
  // Shown and edited in percent; stored as a 0..1+ factor.
  const [v, setV] = useDraft(Math.round(value * 100), (pct) => onSave(pct / 100), 250)
  return (
    <Slider
      className="w-64"
      value={v}
      min={min * 100}
      max={max * 100}
      step={5}
      unit="%"
      resetValue={100}
      onChange={setV}
    />
  )
}

function MeterTest(): ReactNode {
  const [on, setOn] = useState(false)
  const levels = useStore((s) => s.levels)
  useEffect(() => {
    if (!on) return
    sk()
      .invoke('audio:test', true)
      .catch((e) =>
        useStore.getState().toast('error', `Couldn't start the audio test: ${errText(e)}`)
      )
    return () =>
      void sk()
        .invoke('audio:test', false)
        .catch(() => {})
  }, [on])
  return (
    <div className="px-5 py-3.5">
      <div className="flex items-center gap-6">
        <div className="flex-1">
          <div className="text-sm font-medium">Level meters</div>
          <div className="mt-0.5 text-xs text-secondary">
            Check that both your voice and the call are coming through.
          </div>
        </div>
        <Button color="secondary" variant="soft" size="sm" onClick={() => setOn(!on)}>
          {on ? 'Stop test' : 'Test audio'}
        </Button>
      </div>
      {on && (
        <div className="mt-3 grid gap-2">
          <LevelMeter label="You" level={levels.you} />
          <LevelMeter label="Them" level={levels.them} />
        </div>
      )}
    </div>
  )
}

function HotkeyList({
  hotkeys,
  onSave
}: {
  hotkeys: Hotkey[]
  onSave: (h: Hotkey[]) => void
}): ReactNode {
  const [recording, setRecording] = useState<string | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    if (!recording) return
    const onKey = (e: KeyboardEvent): void => {
      e.preventDefault()
      if (e.key === 'Escape') return setRecording(null)
      const acc = toAccelerator(e)
      if (!acc) return
      const clash = hotkeys.find((h) => h.accelerator === acc && h.id !== recording)
      if (clash) return setError(`${keycaps(acc)} is already used for "${clash.label}".`)
      setError('')
      setRecording(null)
      onSave(hotkeys.map((h) => (h.id === recording ? { ...h, accelerator: acc } : h)))
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [recording, hotkeys, onSave])

  return (
    <>
      {hotkeys.map((h) => (
        <div key={h.id} className="flex items-center gap-4 px-5 py-2.5">
          <span className="flex-1 text-sm">{h.label}</span>
          <button
            onClick={() => {
              setError('')
              setRecording(recording === h.id ? null : h.id)
            }}
            onBlur={() => recording === h.id && setRecording(null)}
            className={`flex h-7 min-w-28 items-center justify-center rounded-md border px-2 text-sm ${
              recording === h.id
                ? 'border-[var(--color-ring)] text-secondary'
                : 'border-default hover:bg-[var(--alpha-04)]'
            }`}
          >
            {recording === h.id ? 'Press keys… (Esc)' : <Kbd>{keycaps(h.accelerator)}</Kbd>}
          </button>
        </div>
      ))}
      {error && <p className="px-5 py-2.5 text-sm text-danger">{error}</p>}
    </>
  )
}

function VertexTest(): ReactNode {
  const [result, setResult] = useState<Permissions['vertex'] | null>(null)
  const [busy, setBusy] = useState(false)
  async function test(): Promise<void> {
    setBusy(true)
    try {
      setResult((await sk().invoke('permissions:check')).vertex)
    } catch (e) {
      setResult({ ok: false, message: errText(e) })
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="flex items-center gap-4 px-5 py-3.5">
      <div className="min-w-0 flex-1 text-sm">
        {result ? (
          <span
            className={`flex items-center gap-1.5 ${result.ok ? 'text-success' : 'text-danger'}`}
          >
            {result.ok ? (
              <Check className="size-4 shrink-0" />
            ) : (
              <CircleAlert className="size-4 shrink-0" />
            )}
            <span className="selectable">{result.message}</span>
          </span>
        ) : (
          <span className="text-secondary">
            Sends a tiny request to check the project, region and key.
          </span>
        )}
      </div>
      <Button color="secondary" variant="soft" size="sm" onClick={test} loading={busy}>
        Test connection
      </Button>
    </div>
  )
}
