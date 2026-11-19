import { useState, type ReactNode } from 'react'
import { FileText, Paperclip, Play, X } from 'lucide-react'
import { Button } from '@openai/apps-sdk-ui/components/Button'
import { Input } from '@openai/apps-sdk-ui/components/Input'
import { SegmentedControl } from '@openai/apps-sdk-ui/components/SegmentedControl'
import { Textarea } from '@openai/apps-sdk-ui/components/Textarea'
import type { BriefFile, SessionPreset } from '../../../shared/types'
import { sk } from '../bridge'
import { go, PRESETS } from '../lib'
import { errText } from '../store'
import { Panel, Tip } from './ui'

const kb = (b: number): string =>
  b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1e3))} KB`

export function StartForm(): ReactNode {
  const [title, setTitle] = useState('')
  const [preset, setPreset] = useState<SessionPreset>('interview')
  const [notes, setNotes] = useState('')
  const [files, setFiles] = useState<BriefFile[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function pick(): Promise<void> {
    try {
      const picked = await sk().invoke('brief:pickFiles')
      setFiles([...files, ...picked.filter((p) => !files.some((f) => f.path === p.path))])
    } catch (e) {
      setError(`Couldn't add files: ${errText(e)}`)
    }
  }

  async function start(): Promise<void> {
    setBusy(true)
    setError('')
    try {
      await sk().invoke('session:start', {
        title: title.trim() || 'Untitled session',
        preset,
        notes,
        files
      })
      go('live')
    } catch (e) {
      setError(`Couldn't start the session: ${errText(e)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Panel className="p-5">
      <div className="flex items-baseline justify-between gap-4">
        <h2 className="heading-xs">Start a session</h2>
        <span className="text-xs text-tertiary">Sidekick listens to both sides once you start</span>
      </div>
      <div className="mt-4 grid gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <Input
            className="min-w-56 flex-1"
            placeholder="Title, e.g. Northwind · System design round"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
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
        <Textarea
          rows={4}
          placeholder="Role, company, what you want out of this call…"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          aria-label="Notes"
        />
        <div
          role="button"
          tabIndex={0}
          onClick={pick}
          onKeyDown={(e) => e.key === 'Enter' && pick()}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault()
            pick()
          }}
          className="flex cursor-pointer items-center gap-3 rounded-lg border border-dashed border-strong px-3.5 py-2.5 text-sm text-secondary hover:bg-[var(--alpha-04)]"
        >
          <Paperclip className="size-4 shrink-0" />
          <span className="flex-1">
            Add files for context: resume, job description, deck{' '}
            <span className="text-tertiary">(PDF, images, text)</span>
          </span>
        </div>
        {files.length > 0 && (
          <ul className="flex flex-wrap gap-2">
            {files.map((f) => (
              <li
                key={f.id}
                className="flex items-center gap-2 rounded-md bg-surface-secondary py-1 pr-1 pl-2.5 text-sm"
              >
                <FileText className="size-3.5 text-secondary" />
                <span className="max-w-56 truncate">{f.name}</span>
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
              </li>
            ))}
          </ul>
        )}
        <div className="mt-1 flex items-center justify-end gap-3">
          {error && <p className="mr-auto text-sm text-danger">{error}</p>}
          <Button color="success" onClick={start} loading={busy}>
            <Play className="fill-current" />
            Start session
          </Button>
        </div>
      </div>
    </Panel>
  )
}
