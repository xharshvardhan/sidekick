// Shared contract between the main process (owns all state and work) and the windows (display only).
// Both sides import from here. Change it only with a matching change on both sides.

export type Speaker = 'you' | 'them'

/** One transcribed stretch of speech from one channel. Mic is always 'you', system audio is 'them'. */
export interface Utterance {
  id: string
  speaker: Speaker
  text: string
  startedAt: number // epoch ms, when the speech began
  endedAt: number
}

export type CardSource = 'auto' | 'ask' | 'screen' | 'deeper'
export type CardStatus = 'streaming' | 'done' | 'error'

/** One section of a card: the answer to one question or follow-up. */
export interface CardSection {
  id: string
  prompt: string // what they asked, in <= 10 words ("Design a rate limiter")
  say: string // one sentence the user can say right now
  points: CardPoint[] // short talking points, in speaking order
  detail: string // optional markdown: code, numbers, longer explanation
  deepening?: boolean // the deep model is writing `detail` right now
  coding?: boolean // a coding problem: the card holds while the user types the solution
}

export interface CardPoint {
  id: string
  text: string
  covered: boolean // the user has already said this
}

/** What the overlay shows. A card covers one topic; follow-ups add sections to the same card. */
export interface Card {
  id: string
  createdAt: number
  updatedAt?: number // last time any section changed (default createdAt); a code card holds for a while after
  source: CardSource
  status: CardStatus
  sections: CardSection[] // newest last
  error?: string
}

export type SessionPreset = 'interview' | 'sales' | 'meeting' | 'custom'

export interface BriefFile {
  id: string
  name: string
  mimeType: string
  path: string // copied into the app's data folder
  bytes: number
}

/** One labelled answer from the start form ("Company" → "Northwind"). The form decides the labels per preset. */
export interface BriefDetail {
  label: string
  value: string
}

/** Context the user gives before a call. */
export interface Brief {
  title: string
  preset: SessionPreset
  notes: string // free text: anything else to remember
  files: BriefFile[]
  details?: BriefDetail[] // structured answers (company, role, job description, your angle…); empty values are dropped
}

/** Where a profile draft comes from: picked files (resume), a past session, or pasted text (a transcript, a bio). */
export type ProfileSource =
  { kind: 'files' } | { kind: 'session'; id: string } | { kind: 'text'; text: string }

export type SessionState = 'idle' | 'live' | 'paused' | 'ended'

export interface SessionMeta {
  id: string
  title: string
  preset: SessionPreset
  startedAt: number
  endedAt?: number
  utteranceCount: number
  cardCount: number
}

export interface Recap {
  summary: string // markdown
  actionItems: string[]
  questions: { asked: string; howItWent: string }[]
}

export interface Session extends SessionMeta {
  brief: Brief
  utterances: Utterance[]
  cards: Card[]
  summary: string // rolling summary of older conversation
  recap?: Recap
}

/** Live view state pushed to every window on each change. */
export interface LiveState {
  session: SessionState
  sessionId: string | null
  title: string
  startedAt: number | null
  utterances: Utterance[] // full list for the app window; overlay uses the tail
  partial: { you: boolean; them: boolean } // someone is speaking right now on that channel
  levels: { you: number; them: number } // 0..1 audio level, updated ~8x/s via the 'levels' event instead
  cards: Card[]
  activeCardId: string | null // the card the overlay shows
  queuedCardId: string | null // a newer card waiting while the user finishes speaking or has pinned
  pinned: boolean
  autoCue: boolean
  thinking: boolean // a cue is being decided or generated
  audio: AudioHealth
}

export interface AudioHealth {
  mic: 'ok' | 'starting' | 'denied' | 'error' | 'off'
  system: 'ok' | 'starting' | 'denied' | 'error' | 'off'
  echoCancellation: boolean
  message?: string
}

export interface Bounds {
  x: number
  y: number
  width: number
  height: number
}
export const OVERLAY_MIN = { width: 360, height: 140 }

export type WindowMode = 'app' | 'overlay' // app = normal window (overlay optional); overlay = overlay only

export interface Hotkey {
  id: HotkeyId
  label: string
  accelerator: string // Electron accelerator, e.g. "Alt+Shift+A"
}

export type HotkeyId =
  | 'ask' // help me now
  | 'screen' // capture screen and solve
  | 'deeper' // expand the current card with the stronger model
  | 'prevCard'
  | 'nextCard'
  | 'pin'
  | 'toggleOverlay' // show/hide overlay
  | 'toggleMode' // app window <-> overlay only
  | 'toggleListening' // pause/resume

export interface Settings {
  vertex: { project: string; location: string; credentialsPath: string }
  models: { stt: string; cue: string; deep: string }
  profile: string // "About me": persistent context used in every session (resume, role, style)
  autoCue: boolean
  answerStyle: 'brief' | 'standard'
  language: string // BCP-47, '' = auto
  echoCancellation: boolean
  overlay: {
    showOnStart: boolean
    hideFromScreenShare: boolean
    opacity: number // 0.6..1
    fontScale: number // 0.9..1.3
    bounds: Bounds | null
  }
  theme: 'system' | 'light' | 'dark'
  hotkeys: Hotkey[]
  onboarded: boolean
}

export interface Permissions {
  microphone: 'granted' | 'denied' | 'unknown'
  screen: 'granted' | 'denied' | 'unknown' // Screen Recording: needed for call audio and screenshots
  vertex: { ok: boolean; message: string } // result of a tiny test request
}

/** Renderer -> main requests (ipcRenderer.invoke). Channel name = key. */
export interface Api {
  'live:get': () => LiveState
  'session:start': (brief: Brief) => { sessionId: string }
  'session:end': () => void
  'session:pause': (paused: boolean) => void
  'session:list': () => SessionMeta[]
  'session:get': (id: string) => Session | null
  'session:delete': (id: string) => void
  'session:recap': (id: string) => Recap // generate (or return cached) recap
  'brief:pickFiles': () => BriefFile[] // opens a file dialog, copies files into app data
  // Reads the source and returns a new "About me" text: the current profile merged with what was learned.
  // Does not save; the window shows it for review and saves through settings:set. '' if the dialog was cancelled.
  'profile:draft': (source: ProfileSource) => string
  'cue:ask': (question: string) => void // typed question, or '' for "help me now"
  'cue:screen': () => void
  'cue:deeper': () => void
  'cue:show': (cardId: string) => void
  'cue:step': (dir: -1 | 1) => void
  'cue:pin': (pinned: boolean) => void
  'cue:setAuto': (on: boolean) => void
  'settings:get': () => Settings
  'settings:set': (patch: DeepPartial<Settings>) => Settings
  'permissions:check': () => Permissions
  'permissions:open': (which: 'microphone' | 'screen') => void // open the System Settings pane
  'audio:test': (on: boolean) => void // run capture without a session, for the level meters in setup
  'window:setMode': (mode: WindowMode) => void
  'window:toggleOverlay': () => void
  'window:getMode': () => WindowMode
  'overlay:setBounds': (bounds: Bounds) => void // resize from the overlay's own edge handles
}

/** Main -> renderer events (webContents.send). */
export interface Events {
  live: LiveState // full state on every change (throttled to <= 15/s while streaming)
  levels: { you: number; them: number }
  settings: Settings
  mode: WindowMode
  toast: { kind: 'info' | 'error'; text: string }
}

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] }
