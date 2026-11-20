import './main.css'

import { StrictMode } from 'react'
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

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
