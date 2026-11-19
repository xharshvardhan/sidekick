import './main.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { demoBackdrop, demoMode, demoScene, setBridge } from './bridge'
import { createDemoBridge } from './demo/demoBridge'
import { connectStore, useStore } from './store'

if (demoMode) setBridge(createDemoBridge(demoMode, demoScene))
if (demoBackdrop) document.documentElement.classList.add('overlay')

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
