import type { ReactNode } from 'react'
import { ArrowRight } from 'lucide-react'
import { Button } from '@openai/apps-sdk-ui/components/Button'
import { SessionList } from '../components/SessionList'
import { StartForm } from '../components/StartForm'
import { LiveDot, Page, Panel } from '../components/ui'
import { go } from '../lib'
import { useStore } from '../store'

export function Home(): ReactNode {
  const live = useStore((s) => s.live)
  const inSession = live?.session === 'live' || live?.session === 'paused'
  return (
    <Page title="Home">
      {inSession ? (
        <Panel className="flex items-center gap-3 px-5 py-4">
          <LiveDot paused={live.session === 'paused'} />
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium">{live.title}</div>
            <div className="text-xs text-secondary">
              {live.session === 'paused' ? 'Paused' : 'In progress'} · {live.utterances.length}{' '}
              lines · {live.cards.length} cards
            </div>
          </div>
          <Button color="success" size="sm" onClick={() => go('live')}>
            Open live view
            <ArrowRight />
          </Button>
        </Panel>
      ) : (
        <StartForm />
      )}
      <div className="mt-8 mb-3 flex items-baseline justify-between">
        <h2 className="heading-xs">Recent sessions</h2>
        <button className="text-sm text-secondary hover:text-default" onClick={() => go('history')}>
          See all
        </button>
      </div>
      <SessionList limit={4} />
    </Page>
  )
}
