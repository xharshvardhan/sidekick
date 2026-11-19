import { create } from 'zustand'
import type { Api, DeepPartial, Events, LiveState, Settings, WindowMode } from '../../shared/types'
import { sk } from './bridge'

export interface Toast {
  id: number
  kind: 'info' | 'error'
  text: string
}

interface Store {
  live: LiveState | null
  settings: Settings | null
  mode: WindowMode
  levels: Events['levels']
  toasts: Toast[]
  savedAt: number // last successful settings save, for the quiet "Saved" note
  toast: (kind: Toast['kind'], text: string) => void
  dismiss: (id: number) => void
  saveSettings: (patch: DeepPartial<Settings>) => Promise<void>
}

let toastId = 0

export const useStore = create<Store>((set, get) => ({
  live: null,
  settings: null,
  mode: 'app',
  levels: { you: 0, them: 0 },
  toasts: [],
  savedAt: 0,
  toast: (kind, text) => {
    const id = ++toastId
    set({ toasts: [...get().toasts.slice(-2), { id, kind, text }] })
    setTimeout(() => get().dismiss(id), kind === 'error' ? 8000 : 3500)
  },
  dismiss: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
  saveSettings: async (patch) => {
    try {
      const settings = await sk().invoke('settings:set', patch)
      set({ settings, savedAt: Date.now() })
    } catch (e) {
      get().toast('error', `Couldn't save settings: ${errText(e)}`)
    }
  }
}))

export function errText(e: unknown): string {
  return e instanceof Error
    ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
    : String(e)
}

/** Fire-and-forget invoke for buttons: any failure becomes an error toast in this window. */
export function call<K extends keyof Api>(channel: K, ...args: Parameters<Api[K]>): void {
  sk()
    .invoke(channel, ...args)
    .catch((e) => useStore.getState().toast('error', errText(e)))
}

/** Subscribe the store to the bridge once, and load initial state. */
export async function connectStore(): Promise<void> {
  const b = sk()
  b.on('live', (live) => useStore.setState({ live }))
  b.on('levels', (levels) => useStore.setState({ levels }))
  b.on('settings', (settings) => useStore.setState({ settings }))
  b.on('mode', (mode) => useStore.setState({ mode }))
  b.on('toast', (t) => useStore.getState().toast(t.kind, t.text))
  const [live, settings, mode] = await Promise.all([
    b.invoke('live:get'),
    b.invoke('settings:get'),
    b.invoke('window:getMode')
  ])
  useStore.setState({ live, settings, mode })
}
