import { useEffect, useState, useSyncExternalStore } from 'react'
import { applyDocumentTheme } from '@openai/apps-sdk-ui/theme'
import type { HotkeyId, SessionPreset, Settings } from '../../shared/types'
import { forcedTheme } from './bridge'
import { useStore } from './store'

// ---------- routing: '#/home', '#/session/<id>', '#/overlay' ----------
const subscribeHash = (fn: () => void): (() => void) => {
  window.addEventListener('hashchange', fn)
  return () => window.removeEventListener('hashchange', fn)
}
export function useRoute(): string[] {
  const hash = useSyncExternalStore(subscribeHash, () => location.hash)
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean)
  return parts.length ? parts : ['home']
}
export const go = (path: string): void => {
  location.hash = `#/${path}`
}

// ---------- theme ----------
const darkQuery = window.matchMedia('(prefers-color-scheme: dark)')
export function useTheme(pref: Settings['theme'] | undefined): void {
  const [systemDark, setSystemDark] = useState(darkQuery.matches)
  useEffect(() => {
    const fn = (): void => setSystemDark(darkQuery.matches)
    darkQuery.addEventListener('change', fn)
    return () => darkQuery.removeEventListener('change', fn)
  }, [])
  const wanted = forcedTheme ?? (pref && pref !== 'system' ? pref : systemDark ? 'dark' : 'light')
  useEffect(() => {
    applyDocumentTheme(wanted)
  }, [wanted])
}

// ---------- hotkeys ----------
const SYMBOLS: Record<string, string> = {
  Alt: '⌥',
  Option: '⌥',
  AltGr: '⌥',
  Shift: '⇧',
  Control: '⌃',
  Ctrl: '⌃',
  Command: '⌘',
  Cmd: '⌘',
  CommandOrControl: '⌘',
  CmdOrCtrl: '⌘',
  Super: '⌘',
  Meta: '⌘',
  Up: '↑',
  Down: '↓',
  Left: '←',
  Right: '→',
  Enter: '↩',
  Return: '↩',
  Backspace: '⌫',
  Delete: '⌦',
  Escape: 'Esc',
  Tab: '⇥',
  Space: 'Space'
}
export const keycaps = (accelerator: string): string =>
  accelerator
    .split('+')
    .map((k) => SYMBOLS[k] ?? k.toUpperCase())
    .join('')

export function useHotkey(id: HotkeyId): string {
  const acc = useStore((s) => s.settings?.hotkeys.find((h) => h.id === id)?.accelerator)
  return acc ? keycaps(acc) : ''
}

const CODE_KEYS: Record<string, string> = {
  BracketLeft: '[',
  BracketRight: ']',
  Minus: '-',
  Equal: '=',
  Slash: '/',
  Backslash: '\\',
  Comma: ',',
  Period: '.',
  Semicolon: ';',
  Quote: "'",
  Backquote: '`',
  Space: 'Space',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Enter: 'Enter',
  Tab: 'Tab'
}
/** KeyboardEvent → Electron accelerator, or null if it is only modifiers / has no modifier. */
export function toAccelerator(e: KeyboardEvent): string | null {
  const key = /^Key[A-Z]$/.test(e.code)
    ? e.code.slice(3)
    : /^Digit\d$/.test(e.code)
      ? e.code.slice(5)
      : /^F\d{1,2}$/.test(e.code)
        ? e.code
        : CODE_KEYS[e.code]
  if (!key) return null
  const mods = [
    e.metaKey && 'Command',
    e.ctrlKey && 'Control',
    e.altKey && 'Alt',
    e.shiftKey && 'Shift'
  ].filter(Boolean) as string[]
  if (!mods.length || (mods.length === 1 && mods[0] === 'Shift' && !/^F/.test(key))) return null
  return [...mods, key].join('+')
}

// ---------- formatting ----------
export const PRESETS: { value: SessionPreset; label: string }[] = [
  { value: 'interview', label: 'Interview' },
  { value: 'sales', label: 'Sales call' },
  { value: 'meeting', label: 'Meeting' },
  { value: 'custom', label: 'Custom' }
]
export const presetLabel = (p: SessionPreset): string =>
  PRESETS.find((x) => x.value === p)?.label ?? p

export const wordCount = (t: string): number => t.trim().split(/\s+/).filter(Boolean).length

export function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  const mm = String(Math.floor((s % 3600) / 60)).padStart(h ? 2 : 1, '0')
  const ss = String(s % 60).padStart(2, '0')
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}

export function minutes(ms: number): string {
  const m = Math.round(ms / 60_000)
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`
}

export function when(ts: number): string {
  const d = new Date(ts)
  const days = Math.floor(
    (new Date().setHours(0, 0, 0, 0) - new Date(ts).setHours(0, 0, 0, 0)) / 86_400_000
  )
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  if (days === 0) return `Today, ${time}`
  if (days === 1) return `Yesterday, ${time}`
  if (days < 7) return `${d.toLocaleDateString([], { weekday: 'long' })}, ${time}`
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + `, ${time}`
}

export const timeOfDay = (ts: number): string =>
  new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })

/** Re-render every `ms` (timers). */
export function useNow(ms = 1000): number {
  const [n, setN] = useState(Date.now())
  useEffect(() => {
    const id = setInterval(() => setN(Date.now()), ms)
    return () => clearInterval(id)
  }, [ms])
  return n
}
