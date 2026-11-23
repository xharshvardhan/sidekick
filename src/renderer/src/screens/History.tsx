import { useEffect, useState, type ReactNode } from 'react'
import { ArrowLeft, CircleCheck, FileText, Sparkles, Trash2, UserRound } from 'lucide-react'
import { Button } from '@openai/apps-sdk-ui/components/Button'
import { EmptyMessage } from '@openai/apps-sdk-ui/components/EmptyMessage'
import { LoadingIndicator } from '@openai/apps-sdk-ui/components/Indicator'
import { Markdown } from '@openai/apps-sdk-ui/components/Markdown'
import { SegmentedControl } from '@openai/apps-sdk-ui/components/SegmentedControl'
import type { Recap, Session } from '../../../shared/types'
import { demoTab, sk } from '../bridge'
import { CardView } from '../components/CardView'
import { SessionList } from '../components/SessionList'
import { Transcript } from '../components/Transcript'
import { IconButton, Page, Panel } from '../components/ui'
import { go, minutes, presetLabel, timeOfDay, when } from '../lib'
import { errText, learnProfile } from '../store'

export function History(): ReactNode {
  return (
    <Page title="History">
      <SessionList />
    </Page>
  )
}

type Tab = 'recap' | 'transcript' | 'cards'

export function SessionPage({ id }: { id: string }): ReactNode {
  const [session, setSession] = useState<Session | null | undefined>(undefined)
  const [error, setError] = useState('')
  const [tab, setTab] = useState<Tab>((demoTab as Tab) || 'recap')
  const [confirming, setConfirming] = useState(false)
  const [learning, setLearning] = useState(false)
  const [learnError, setLearnError] = useState('')

  useEffect(() => {
    sk()
      .invoke('session:get', id)
      .then(setSession)
      .catch((e) => setError(errText(e)))
  }, [id])

  async function remove(): Promise<void> {
    if (!confirming) return setConfirming(true)
    try {
      await sk().invoke('session:delete', id)
      go('history')
    } catch (e) {
      setError(`Couldn't delete: ${errText(e)}`)
    }
  }

  async function learn(): Promise<void> {
    setLearning(true)
    setLearnError('')
    try {
      if (await learnProfile({ kind: 'session', id })) go('settings')
    } catch (e) {
      setLearnError(`Couldn't learn from this call: ${errText(e)}`)
    } finally {
      setLearning(false)
    }
  }

  const back = (
    <IconButton label="Back to History" onClick={() => go('history')}>
      <ArrowLeft />
    </IconButton>
  )
  if (error || session === null)
    return (
      <Page title={<span className="flex items-center gap-2">{back} Session</span>}>
        <p className="text-sm text-danger">{error || 'This session no longer exists.'}</p>
      </Page>
    )
  if (!session)
    return (
      <Page title="">
        <div className="flex items-center gap-2 text-sm text-secondary">
          <LoadingIndicator size={14} /> Loading session…
        </div>
      </Page>
    )

  return (
    <Page
      wide
      title={
        <span className="flex min-w-0 items-center gap-2">
          <span className="no-drag -ml-2">{back}</span>
          <span className="truncate">{session.title}</span>
        </span>
      }
      actions={
        <>
          <Button
            color="secondary"
            variant="outline"
            size="sm"
            onClick={learn}
            loading={learning}
            disabled={!session.utterances.some((u) => u.speaker === 'you')}
          >
            <UserRound />
            Learn about me from this call
          </Button>
          <Button
            color="danger"
            variant={confirming ? 'solid' : 'ghost'}
            size="sm"
            onClick={remove}
            onBlur={() => setConfirming(false)}
          >
            <Trash2 />
            {confirming ? 'Click again to delete' : 'Delete'}
          </Button>
        </>
      }
    >
      <p className="-mt-1 text-sm text-secondary">
        {presetLabel(session.preset)} · {when(session.startedAt)}
        {session.endedAt && ` · ${minutes(session.endedAt - session.startedAt)}`} ·{' '}
        {session.utterances.length} lines · {session.cards.length} cards
      </p>
      {learnError && <p className="mt-2 text-sm text-danger">{learnError}</p>}
      <SegmentedControl<Tab>
        className="mt-4"
        aria-label="Session view"
        value={tab}
        onChange={setTab}
      >
        <SegmentedControl.Option value="recap">Recap</SegmentedControl.Option>
        <SegmentedControl.Option value="transcript">Transcript</SegmentedControl.Option>
        <SegmentedControl.Option value="cards">Cards</SegmentedControl.Option>
      </SegmentedControl>
      <div className="mt-5">
        {tab === 'recap' && (
          <RecapView session={session} onRecap={(recap) => setSession({ ...session, recap })} />
        )}
        {tab === 'transcript' && (
          <Panel className="h-[520px] overflow-hidden">
            <Transcript
              utterances={session.utterances}
              empty={
                <p className="py-10 text-center text-sm text-secondary">
                  Nothing was transcribed in this session.
                </p>
              }
            />
          </Panel>
        )}
        {tab === 'cards' &&
          (session.cards.length ? (
            <div className="grid grid-cols-1 gap-3">
              {session.cards.map((c) => (
                <Panel key={c.id} className="p-5">
                  <div className="mb-2 text-xs text-tertiary">{timeOfDay(c.createdAt)}</div>
                  <CardView card={c} />
                </Panel>
              ))}
            </div>
          ) : (
            <p className="py-10 text-center text-sm text-secondary">
              No cards were shown in this session.
            </p>
          ))}
      </div>
    </Page>
  )
}

function RecapView({
  session,
  onRecap
}: {
  session: Session
  onRecap: (r: Recap) => void
}): ReactNode {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function generate(): Promise<void> {
    setBusy(true)
    setError('')
    try {
      onRecap(await sk().invoke('session:recap', session.id))
    } catch (e) {
      setError(`Couldn't write the recap: ${errText(e)}`)
    } finally {
      setBusy(false)
    }
  }
  const { recap } = session
  if (!recap)
    return (
      <Panel>
        <EmptyMessage className="py-12">
          <EmptyMessage.Icon>
            <FileText />
          </EmptyMessage.Icon>
          <EmptyMessage.Title>No recap yet</EmptyMessage.Title>
          <EmptyMessage.Description>
            A recap summarises the call, lists action items, and reviews how each question went. It
            takes about ten seconds.
          </EmptyMessage.Description>
          <EmptyMessage.ActionRow>
            <Button color="primary" onClick={generate} loading={busy}>
              <Sparkles />
              Generate recap
            </Button>
          </EmptyMessage.ActionRow>
          {error && <p className="mt-3 text-sm text-danger">{error}</p>}
        </EmptyMessage>
      </Panel>
    )
  return (
    <div className="grid grid-cols-1 gap-4">
      <Panel className="selectable p-5">
        <h3 className="mb-2 heading-xs">Summary</h3>
        <Markdown skipHtml className="text-sm">
          {recap.summary}
        </Markdown>
      </Panel>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Panel className="selectable p-5">
          <h3 className="mb-3 heading-xs">Action items</h3>
          {recap.actionItems.length ? (
            <ul className="space-y-2.5 text-sm">
              {recap.actionItems.map((a) => (
                <li key={a} className="flex gap-2.5">
                  <CircleCheck className="mt-0.5 size-4 shrink-0 text-tertiary" />
                  {a}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-secondary">No action items came up.</p>
          )}
        </Panel>
        <Panel className="selectable p-5">
          <h3 className="mb-3 heading-xs">Questions asked</h3>
          <ul className="space-y-3 text-sm">
            {recap.questions.map((q) => (
              <li key={q.asked}>
                <p className="font-medium">{q.asked}</p>
                <p className="mt-0.5 text-secondary">{q.howItWent}</p>
              </li>
            ))}
          </ul>
        </Panel>
      </div>
    </div>
  )
}
