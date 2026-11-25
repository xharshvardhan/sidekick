// Settings: defaults + a JSON file. Only `set` writes, always as a merge onto what is on disk. No Electron imports.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import type { DeepPartial, Hotkey, Settings } from '../shared/types'

export const DEFAULT_HOTKEYS: Hotkey[] = [
  { id: 'ask', label: 'Help me now', accelerator: 'Alt+Shift+A' },
  { id: 'screen', label: 'Capture screen and solve', accelerator: 'Alt+Shift+S' },
  { id: 'deeper', label: 'Go deeper on this card', accelerator: 'Alt+Shift+D' },
  { id: 'prevCard', label: 'Previous card', accelerator: 'Alt+Shift+[' },
  { id: 'nextCard', label: 'Next card', accelerator: 'Alt+Shift+]' },
  { id: 'pin', label: 'Pin card', accelerator: 'Alt+Shift+P' },
  { id: 'copy', label: 'Copy the next block of the card', accelerator: 'Alt+Shift+C' },
  { id: 'toggleOverlay', label: 'Show or hide overlay', accelerator: 'Alt+Shift+H' },
  { id: 'toggleMode', label: 'Switch app / overlay mode', accelerator: 'Alt+Shift+M' },
  { id: 'toggleListening', label: 'Pause or resume listening', accelerator: 'Alt+Shift+L' }
]

export function defaultSettings(env: NodeJS.ProcessEnv = {}): Settings {
  return {
    vertex: {
      project: env.GOOGLE_CLOUD_PROJECT ?? '',
      location: env.GOOGLE_CLOUD_LOCATION ?? 'global',
      credentialsPath: env.GOOGLE_APPLICATION_CREDENTIALS ?? ''
    },
    models: { stt: 'gemini-3.5-flash-lite', cue: 'gemini-3.5-flash', deep: 'gemini-4-hydrogen' },
    profile: '',
    autoCue: true,
    answerStyle: 'standard',
    language: '',
    echoCancellation: true,
    overlay: {
      showOnStart: true,
      hideFromScreenShare: false,
      opacity: 1,
      fontScale: 1,
      bounds: null
    },
    theme: 'system',
    hotkeys: DEFAULT_HOTKEYS,
    onboarded: false
  }
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)

/** Deep merge; arrays and null replace wholesale, undefined is ignored. */
export function merge<T>(base: T, patch: unknown): T {
  if (!isObj(base) || !isObj(patch)) return (patch === undefined ? base : patch) as T
  const out: Record<string, unknown> = { ...base }
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue
    out[k] = isObj(out[k]) && isObj(v) ? merge(out[k], v) : v
  }
  return out as T
}

export class SettingsStore {
  value: Settings

  /** `seed` is used only when no file exists yet (first run), e.g. Vertex values from .env.local. */
  constructor(
    private file: string,
    seed: Settings
  ) {
    let disk: unknown = null
    if (existsSync(file)) {
      try {
        disk = JSON.parse(readFileSync(file, 'utf8'))
      } catch {
        disk = null // unreadable: keep defaults in memory, do not overwrite the file until the user saves
      }
    }
    this.value = merge(seed, disk ?? {})
    // keep any hotkeys added in later versions
    const have = new Set(this.value.hotkeys.map((h) => h.id))
    this.value.hotkeys = [...this.value.hotkeys, ...DEFAULT_HOTKEYS.filter((h) => !have.has(h.id))]
    if (!existsSync(file)) this.write()
  }

  set(patch: DeepPartial<Settings>): Settings {
    this.value = merge(this.value, patch)
    this.write()
    return this.value
  }

  private write(): void {
    mkdirSync(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify(this.value, null, 2))
    renameSync(tmp, this.file)
  }
}
