import type { ReactNode } from 'react'
import { Sidebar } from './components/Sidebar'
import { Toasts } from './components/Toasts'
import { useRoute, useTheme } from './lib'
import { History, SessionPage } from './screens/History'
import { Home } from './screens/Home'
import { Live } from './screens/Live'
import { Overlay } from './screens/Overlay'
import { Settings } from './screens/Settings'
import { Setup } from './screens/Setup'
import { useStore } from './store'

export function App(): ReactNode {
  const [route, param] = useRoute()
  const settings = useStore((s) => s.settings)
  useTheme(settings?.theme)

  if (route === 'overlay') return <Overlay />
  if (!settings) return <div className="drag h-full" />
  if (!settings.onboarded)
    return (
      <>
        <Setup firstRun />
        <Toasts />
      </>
    )

  return (
    <div className="flex h-full">
      <Sidebar route={route} />
      <main className="min-w-0 flex-1 bg-surface">
        {route === 'live' ? (
          <Live />
        ) : route === 'history' ? (
          <History />
        ) : route === 'session' && param ? (
          <SessionPage key={param} id={param} />
        ) : route === 'settings' ? (
          <Settings />
        ) : route === 'setup' ? (
          <Setup firstRun={false} />
        ) : (
          <Home />
        )}
      </main>
      <Toasts />
    </div>
  )
}
