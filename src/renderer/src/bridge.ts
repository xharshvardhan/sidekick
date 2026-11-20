import type { Api, Events } from '../../shared/types'

export interface Bridge {
  invoke<K extends keyof Api>(channel: K, ...args: Parameters<Api[K]>): Promise<ReturnType<Api[K]>>
  on<K extends keyof Events>(event: K, fn: (payload: Events[K]) => void): () => void
}

const params = new URLSearchParams(location.search)
/** '' when not in demo mode, otherwise the demo variant ('1', 'empty'). */
export const demoMode: string =
  params.get('demo') ?? ((window as { sidekick?: Bridge }).sidekick ? '' : '1')
/** Demo-only: which overlay scene to seed, and which test backdrop to paint behind it. */
export const demoScene = params.get('scene') ?? ''
export const demoBackdrop = params.get('backdrop') ?? ''
export const forcedTheme = params.get('theme') as 'light' | 'dark' | null

let bridge: Bridge | null = null

export function setBridge(b: Bridge): void {
  bridge = b
}

export function sk(): Bridge {
  if (!bridge) bridge = (window as { sidekick?: Bridge }).sidekick ?? null
  if (!bridge) throw new Error('Sidekick bridge is not available')
  return bridge
}

/** Demo-only: open a session page on this tab ('cards'). */
export const demoTab = params.get('tab') ?? ''
/** Demo-only: start with an empty About-me profile, or with a draft waiting for review in Settings. */
export const demoNoProfile = params.has('noprofile')
export const demoReview = params.has('review')
export const demoFilled = params.has('filled') // start form pre-filled
/** Demo-only: swap in long, awkward content (long titles, URLs, tables, 30 sessions) and optionally a long error toast. */
export const demoStress = params.has('stress')
export const demoToast = params.has('toast')
