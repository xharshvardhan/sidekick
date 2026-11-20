import { useEffect, useState, type ReactNode } from 'react'
import {
  ChevronDown,
  ChevronRight,
  FileText,
  History,
  Paperclip,
  Play,
  UserRound,
  X
} from 'lucide-react'
import { Button } from '@openai/apps-sdk-ui/components/Button'
import { Input } from '@openai/apps-sdk-ui/components/Input'
import { Menu } from '@openai/apps-sdk-ui/components/Menu'
import { SegmentedControl } from '@openai/apps-sdk-ui/components/SegmentedControl'
import { Textarea } from '@openai/apps-sdk-ui/components/Textarea'
import type { BriefFile, SessionMeta, SessionPreset } from '../../../shared/types'
import { demoFilled, demoStress, sk } from '../bridge'
import { stressFiles, stressText } from '../demo/seed'
import { go, PRESETS, wordCount } from '../lib'
import { errText, learnProfile, useStore } from '../store'
import { Panel, Tip } from './ui'

const kb = (b: number): string =>
  b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1e3))} KB`

interface Field {
  label: string
  placeholder: string
  rows?: number // textarea when set, one-line input otherwise
  wide?: boolean // spans both columns
}

/** The labelled questions per preset. The label is what the model sees ("Company: Northwind"). */
const FIELDS: Record<SessionPreset, Field[]> = {
  interview: [
    { label: 'Company', placeholder: 'Northwind' },
    { label: 'Role', placeholder: 'Senior Backend Engineer' },
    {
      label: 'Your angle',
      placeholder:
        'Why this company, why you are moving, what to stress, numbers you are fine sharing (notice period, expected salary)',
      rows: 3,
      wide: true
    }
  ],
  sales: [
    { label: 'Prospect', placeholder: 'Company, and who is on the call' },
    { label: 'Goal for this call', placeholder: 'Book a demo, agree on a pilot…' },
    {
      label: 'What you are selling',
      placeholder: 'Product, pricing, facts you can quote',
      rows: 3
    },
    { label: 'Likely objections', placeholder: 'Too expensive, we already use X…', rows: 3 }
  ],
  meeting: [
    { label: 'Agenda', placeholder: 'What is on the list', rows: 3 },
    { label: 'Decisions needed', placeholder: 'What has to be settled today', rows: 3 },
    {
      label: 'Your role and position',
      placeholder: 'Your role here, and where you stand',
      wide: true
    }
  ],
  custom: []
}

const ROUNDS = ['Intro call', 'Technical', 'System design', 'Behavioural', 'Hiring manager']
const JD = 'Job description'

function Label({ children }: { children: ReactNode }): ReactNode {
  return <div className="mb-1 text-xs font-medium text-secondary">{children}</div>
}

export function StartForm(): ReactNode {
  const profile = useStore((s) => s.settings?.profile ?? '')
  const [typedTitle, setTypedTitle] = useState<string | null>(null) // null: follow the fields
  const [preset, setPreset] = useState<SessionPreset>('interview')
  const [values, setValues] = useState<Record<string, string>>(
    demoStress
      ? {
          Company: stressText.title,
          Role: stressText.title,
          Round: 'Technical',
          'Your angle': stressText.message,
          [JD]: Array.from({ length: 300 }, (_, i) => `word${i}`).join(' ')
        }
      : demoFilled
        ? {
            Company: 'Northwind Health',
            Role: 'AI Engineer',
            Round: 'Technical',
            'Your angle':
              'Moving from payments to AI products. Stress the settlement rewrite (batch to under 2 minutes). Notice period 60 days.'
          }
        : {}
  )
  const [notes, setNotes] = useState('')
  const [files, setFiles] = useState<BriefFile[]>(demoStress ? stressFiles : [])
  const [jdOpen, setJdOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const v = (label: string): string => values[label] ?? ''
  const setV = (label: string, value: string): void => setValues({ ...values, [label]: value })

  const autoTitle = (
    preset === 'interview'
      ? [v('Company'), v('Role'), v('Round')]
      : preset === 'sales'
        ? [v('Prospect'), v('Goal for this call')]
        : preset === 'meeting'
          ? [v('Agenda').split('\n')[0]]
          : []
  )
    .map((x) => x.trim())
    .filter(Boolean)
    .join(' · ')
    .slice(0, 80)
  const title = typedTitle ?? autoTitle

  async function pick(): Promise<void> {
    try {
      const picked = await sk().invoke('brief:pickFiles')
      setFiles([...files, ...picked.filter((p) => !files.some((f) => f.path === p.path))])
    } catch (e) {
      setError(`Couldn't add files: ${errText(e)}`)
    }
  }

  async function addResume(): Promise<void> {
    setBusy(true)
    setError('')
    try {
      if (await learnProfile({ kind: 'files' })) go('settings')
    } catch (e) {
      setError(`Couldn't read the resume: ${errText(e)}`)
    } finally {
      setBusy(false)
    }
  }

  async function reuse(id: string): Promise<void> {
    try {
      const s = await sk().invoke('session:get', id)
      if (!s) return
      const b = s.brief
      setTypedTitle(b.title)
      setPreset(b.preset)
      setNotes(b.notes)
      setFiles(b.files)
      setValues(Object.fromEntries((b.details ?? []).map((d) => [d.label, d.value])))
      setJdOpen(false)
    } catch (e) {
      setError(`Couldn't load that brief: ${errText(e)}`)
    }
  }

  async function start(): Promise<void> {
    setBusy(true)
    setError('')
    const labels = [
      ...FIELDS[preset].map((f) => f.label),
      ...(preset === 'interview' ? ['Round', JD] : [])
    ]
    try {
      await sk().invoke('session:start', {
        title: title.trim() || 'Untitled session',
        preset,
        notes,
        files,
        details: labels.map((label) => ({ label, value: v(label).trim() })).filter((d) => d.value)
      })
      go('live')
    } catch (e) {
      setError(`Couldn't start the session: ${errText(e)}`)
    } finally {
      setBusy(false)
    }
  }

  const input = (f: Field): ReactNode => (
    <div key={f.label} className={f.wide ? 'sm:col-span-2' : ''}>
      <Label>{f.label}</Label>
      {f.rows ? (
        <Textarea
          rows={f.rows}
          placeholder={f.placeholder}
          value={v(f.label)}
          onChange={(e) => setV(f.label, e.target.value)}
          aria-label={f.label}
        />
      ) : (
        <Input
          placeholder={f.placeholder}
          value={v(f.label)}
          onChange={(e) => setV(f.label, e.target.value)}
          aria-label={f.label}
        />
      )}
    </div>
  )
  const [first, ...rest] = FIELDS[preset]

  return (
    <Panel className="p-5">
      <div className="flex items-center justify-between gap-4">
        <h2 className="heading-xs">Start a session</h2>
        <ReuseMenu onPick={reuse} />
      </div>

      {profile.trim() ? (
        <p className="mt-1 text-xs text-tertiary">
          Using your profile · {wordCount(profile)} words ·{' '}
          <button className="underline hover:text-default" onClick={() => go('settings')}>
            Edit
          </button>
        </p>
      ) : (
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg bg-surface-secondary px-3.5 py-2.5">
          <UserRound className="size-4 shrink-0 text-secondary" />
          <p className="min-w-0 flex-1 basis-64 text-sm text-secondary">
            Sidekick knows nothing about you yet, so answers about your background will have blanks.
          </p>
          <Button color="secondary" variant="outline" size="xs" onClick={addResume} loading={busy}>
            Add your resume
          </Button>
          <button
            className="text-sm text-secondary underline hover:text-default"
            onClick={() => go('settings')}
          >
            Write it in Settings
          </button>
        </div>
      )}

      <div className="mt-4 grid grid-cols-1 gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <Input
            className="min-w-56 flex-1"
            placeholder="Title, e.g. Northwind · System design round"
            value={title}
            onChange={(e) => setTypedTitle(e.target.value || null)}
            onKeyDown={(e) => e.key === 'Enter' && start()}
            aria-label="Session title"
          />
          <SegmentedControl<SessionPreset> aria-label="Preset" value={preset} onChange={setPreset}>
            {PRESETS.map((p) => (
              <SegmentedControl.Option key={p.value} value={p.value}>
                {p.label}
              </SegmentedControl.Option>
            ))}
          </SegmentedControl>
        </div>

        {first && (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {preset === 'interview' ? (
              <>
                {input(first)}
                {input(rest[0])}
                <div className="sm:col-span-2">
                  <Label>Round</Label>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {ROUNDS.map((r) => (
                      <button
                        key={r}
                        onClick={() => setV('Round', v('Round') === r ? '' : r)}
                        aria-pressed={v('Round') === r}
                        className={`rounded-full border px-2.5 py-0.5 text-xs ${
                          v('Round') === r
                            ? 'border-transparent bg-[var(--alpha-10)] font-medium text-default'
                            : 'border-default text-secondary hover:bg-[var(--alpha-04)] hover:text-default'
                        }`}
                      >
                        {r}
                      </button>
                    ))}
                    <Input
                      size="xs"
                      className="w-40"
                      placeholder="or type your own"
                      value={ROUNDS.includes(v('Round')) ? '' : v('Round')}
                      onChange={(e) => setV('Round', e.target.value)}
                      aria-label="Round"
                    />
                  </div>
                </div>
                <div className="sm:col-span-2">
                  <button
                    onClick={() => setJdOpen(!jdOpen)}
                    aria-expanded={jdOpen}
                    className="flex items-center gap-1 text-xs font-medium text-secondary hover:text-default"
                  >
                    {jdOpen ? (
                      <ChevronDown className="size-3.5" />
                    ) : (
                      <ChevronRight className="size-3.5" />
                    )}
                    Job description
                    {!jdOpen && v(JD).trim() && (
                      <span className="font-normal text-tertiary">
                        · pasted, {wordCount(v(JD))} words
                      </span>
                    )}
                    {!jdOpen && !v(JD).trim() && (
                      <span className="font-normal text-tertiary">
                        · paste it for sharper answers
                      </span>
                    )}
                  </button>
                  {jdOpen && (
                    <Textarea
                      className="mt-1.5"
                      rows={9}
                      placeholder="Paste the job posting"
                      value={v(JD)}
                      onChange={(e) => setV(JD, e.target.value)}
                      aria-label={JD}
                    />
                  )}
                </div>
                {rest.slice(1).map(input)}
              </>
            ) : (
              FIELDS[preset].map(input)
            )}
          </div>
        )}

        <div>
          {preset !== 'custom' && <Label>Anything else</Label>}
          <Textarea
            rows={preset === 'custom' ? 5 : 2}
            placeholder={
              preset === 'custom'
                ? 'What is this call, who is on it, what do you want out of it…'
                : 'Anything else Sidekick should know'
            }
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            aria-label="Notes"
          />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button color="secondary" variant="outline" size="sm" onClick={pick}>
            <Paperclip />
            Add files
          </Button>
          {files.length === 0 && (
            <span className="text-xs text-tertiary">Resume, deck, notes (PDF, images, text)</span>
          )}
          {files.map((f) => (
            <span
              key={f.id}
              className="flex items-center gap-2 rounded-md bg-surface-secondary py-1 pr-1 pl-2.5 text-sm"
            >
              <FileText className="size-3.5 text-secondary" />
              <span className="max-w-40 truncate">{f.name}</span>
              <span className="text-xs text-tertiary">{kb(f.bytes)}</span>
              <Tip label={`Remove ${f.name}`}>
                <button
                  className="rounded p-0.5 text-tertiary hover:bg-[var(--alpha-08)] hover:text-default"
                  onClick={() => setFiles(files.filter((x) => x.id !== f.id))}
                  aria-label={`Remove ${f.name}`}
                >
                  <X className="size-3.5" />
                </button>
              </Tip>
            </span>
          ))}
          <div className="ml-auto flex items-center gap-3">
            <Button color="success" onClick={start} loading={busy}>
              <Play className="fill-current" />
              Start session
            </Button>
          </div>
        </div>
        {error && <p className="text-sm text-danger">{error}</p>}
      </div>
    </Panel>
  )
}

/** Fill the form from one of the last five sessions (the same company often has several rounds). */
function ReuseMenu({ onPick }: { onPick: (id: string) => void }): ReactNode {
  const [recent, setRecent] = useState<SessionMeta[]>([])
  useEffect(() => {
    sk()
      .invoke('session:list')
      .then((l) => setRecent([...l].sort((a, b) => b.startedAt - a.startedAt).slice(0, 5)))
      .catch(() => {})
  }, [])
  if (!recent.length) return null
  return (
    <Menu>
      <Menu.Trigger>
        <Button color="secondary" variant="ghost" size="xs">
          <History />
          Reuse a previous brief
          <ChevronDown />
        </Button>
      </Menu.Trigger>
      <Menu.Content align="end" width={360}>
        {recent.map((s) => (
          <Menu.Item key={s.id} onSelect={() => onPick(s.id)}>
            <span className="truncate">{s.title}</span>
          </Menu.Item>
        ))}
      </Menu.Content>
    </Menu>
  )
}
