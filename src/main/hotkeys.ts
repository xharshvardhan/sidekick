// Global hotkeys from settings. Returns the ones that failed so the UI can say so.
import { globalShortcut } from 'electron'
import type { Hotkey, HotkeyId } from '../shared/types'

export function registerHotkeys(keys: Hotkey[], actions: Record<HotkeyId, () => void>): string[] {
  globalShortcut.unregisterAll()
  const failed: string[] = []
  for (const k of keys) {
    if (!k.accelerator) continue
    let ok: boolean
    try {
      ok = globalShortcut.register(k.accelerator, () => actions[k.id]?.())
    } catch {
      ok = false // invalid accelerator string
    }
    if (!ok) failed.push(`${k.label} (${k.accelerator})`)
  }
  return failed
}
