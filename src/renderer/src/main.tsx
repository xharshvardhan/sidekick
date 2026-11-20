import './main.css'

import { Component, StrictMode, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { demoBackdrop, demoMode, demoReview, demoScene, setBridge } from './bridge'
import { createDemoBridge } from './demo/demoBridge'
import { demoProfile } from './demo/seed'
import { connectStore, useStore } from './store'

if (demoMode) setBridge(createDemoBridge(demoMode, demoScene))
if (demoMode && demoReview) useStore.setState({ profileDraft: demoProfile })
if (demoBackdrop) document.documentElement.classList.add('overlay')

// Truncated text (.truncate) gets its full text as a native tooltip, only when it is actually cut off.
document.addEventListener('pointerover', (e) => {
  const el = (e.target as Element).closest<HTMLElement>('.truncate')
  if (el && !el.title && el.scrollWidth > el.clientWidth) el.title = el.textContent ?? ''
})

connectStore()
  .then(() => {
    if (demoMode && !new URLSearchParams(location.search).has('demo'))
      useStore
        .getState()
        .toast('error', 'The Sidekick engine is not connected, so this window shows demo data.')
  })
  .catch((e) => useStore.getState().toast('error', `Couldn't reach Sidekick: ${String(e)}`))

/** A render error must never leave a window blank mid-call: log it and draw the app again. */
class Recover extends Component<{ children: ReactNode }, { n: number; failedAt: number }> {
  state = { n: 0, failedAt: 0 }
  componentDidCatch(e: Error): void {
    console.error(`render failed, recovering: ${e.message}`)
    const now = Date.now()
    // twice within 2 s means it fails on every draw: stop retrying instead of looping
    if (now - this.state.failedAt > 2000) this.setState({ n: this.state.n + 1, failedAt: now })
  }
  render(): ReactNode {
    return (
      <div key={this.state.n} className="contents">
        {this.props.children}
      </div>
    )
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Recover>
      <App />
    </Recover>
  </StrictMode>
)
