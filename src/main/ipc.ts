// Implements every `Api` channel on ipcMain.handle.
import { BrowserWindow, dialog, ipcMain } from 'electron'
import { copyFileSync, mkdirSync, realpathSync, statSync } from 'fs'
import { basename, join, sep } from 'path'
import type { Part } from '@google/genai'
import type { Api, BriefFile, Recap } from '../shared/types'
import type { Engine } from './engine'
import { newId } from './director/cards'
import { briefParts, mimeFor } from './director/brief'
import { errorMessage, type Llm } from './llm'
import { draftProfile, sessionSelfText } from './profile'
import { generateRecap, type SessionStore } from './sessions'
import type { SettingsStore } from './settings'
import { checkPermissions, openPermissionPane, screenshot } from './system'
import type { Windows } from './windows'

export interface AppCtx {
  engine: Engine
  settings: SettingsStore
  sessions: SessionStore
  windows: Windows
  llm(): Llm
  filesDir: string
  toast(kind: 'info' | 'error', text: string): void
  /** settings:set side effects (llm reset, hotkeys, overlay, broadcast) */
  settingsChanged(prev: ReturnType<SettingsStore['set']>): void
  sessionStarted(): void
  sessionEnded(): void
}

type Impl = {
  [K in keyof Api]: (
    ...args: Parameters<Api[K]>
  ) => ReturnType<Api[K]> | Promise<ReturnType<Api[K]>>
}

const recaps = new Map<string, Promise<Recap>>()

export function recap(ctx: AppCtx, id: string): Promise<Recap> {
  const st = ctx.engine.state
  if (st.sessionId === id && st.session !== 'ended')
    return Promise.reject(new Error('The session is still live.'))
  const s = ctx.sessions.get(id)
  if (!s) return Promise.reject(new Error('Session not found.'))
  if (s.recap) return Promise.resolve(s.recap)
  let p = recaps.get(id)
  if (!p) {
    p = generateRecap(ctx.llm(), ctx.settings.value.models.deep, s)
      .then((r) => {
        const fresh = ctx.sessions.get(id)
        if (fresh) ctx.sessions.save({ ...fresh, recap: r })
        return r
      })
      .finally(() => recaps.delete(id))
    recaps.set(id, p)
  }
  return p
}

let screenToken = 0

/** Take a screenshot (without Sidekick's windows) and ask the director about it; failures become an error card.
 *  A capture that finishes after a newer request, or after its session ended, is dropped. */
export async function screenCue(ctx: AppCtx): Promise<void> {
  const { engine } = ctx
  const token = ++screenToken
  const sessionId = engine.state.sessionId
  const current = (): boolean =>
    token === screenToken &&
    engine.state.sessionId === sessionId &&
    (engine.state.session === 'live' || engine.state.session === 'paused')
  try {
    const jpeg = await ctx.windows.hiddenFromCapture(screenshot)
    if (current()) void engine.director.screen(jpeg)
  } catch (e) {
    if (!current()) return
    engine.deck.addError('screen', (e as Error).message, Date.now())
    engine.changed()
  }
}

/** Brief files come from the renderer: keep only those inside the app's own files folder. */
function ownFiles(files: BriefFile[], dir: string): BriefFile[] {
  const real = (p: string): string | null => {
    try {
      return realpathSync(p)
    } catch {
      return null
    }
  }
  const root = real(dir)
  if (!root) return []
  return files.filter((f) => real(f.path)?.startsWith(root + sep))
}

/** Resume files for the profile builder: read in place, nothing is copied or kept. */
async function pickProfileFiles(parent: BrowserWindow | null): Promise<BriefFile[]> {
  const opts: Electron.OpenDialogOptions = {
    title: 'Choose your resume or notes',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Documents', extensions: ['pdf', 'txt', 'md', 'png', 'jpg', 'jpeg', 'webp'] }]
  }
  const win = BrowserWindow.getFocusedWindow() ?? parent
  const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
  return r.canceled
    ? []
    : r.filePaths.map((path) => ({
        id: path,
        name: basename(path),
        mimeType: mimeFor(path),
        path,
        bytes: statSync(path).size
      }))
}

export function registerIpc(ctx: AppCtx): void {
  const { engine, settings, sessions, windows } = ctx
  const needSession = (): boolean => {
    if (engine.state.session === 'live' || engine.state.session === 'paused') return true
    ctx.toast('info', 'Start a session first.')
    return false
  }

  const api: Impl = {
    'live:get': () => engine.state,
    'session:start': (brief) => {
      if (engine.state.session === 'live' || engine.state.session === 'paused') ctx.sessionEnded()
      const sessionId = engine.start({ ...brief, files: ownFiles(brief.files, ctx.filesDir) })
      ctx.sessionStarted()
      return { sessionId }
    },
    'session:end': () => ctx.sessionEnded(),
    'session:pause': (paused) => engine.pause(paused),
    'session:list': () => sessions.list(),
    'session:get': (id) =>
      engine.state.sessionId === id ? (engine.snapshot() ?? sessions.get(id)) : sessions.get(id),
    'session:delete': (id) => {
      if (engine.state.sessionId === id && engine.state.session !== 'ended') {
        ctx.toast('error', 'End the session before deleting it.')
        return
      }
      sessions.delete(id)
    },
    'session:recap': async (id) => {
      try {
        return await recap(ctx, id)
      } catch (e) {
        const msg = errorMessage(e)
        ctx.toast('error', `Recap failed: ${msg}`)
        throw new Error(msg, { cause: e })
      }
    },
    'brief:pickFiles': async () => {
      const parent = BrowserWindow.getFocusedWindow() ?? windows.app
      const opts: Electron.OpenDialogOptions = {
        title: 'Add files to the brief',
        properties: ['openFile', 'multiSelections'],
        filters: [
          {
            name: 'Documents',
            extensions: ['pdf', 'txt', 'md', 'png', 'jpg', 'jpeg', 'webp', 'csv', 'json']
          },
          { name: 'All files', extensions: ['*'] }
        ]
      }
      const r = parent
        ? await dialog.showOpenDialog(parent, opts)
        : await dialog.showOpenDialog(opts)
      if (r.canceled) return []
      mkdirSync(ctx.filesDir, { recursive: true })
      const out: BriefFile[] = []
      for (const src of r.filePaths) {
        try {
          const id = newId('f')
          const name = basename(src)
          const dest = join(ctx.filesDir, `${id}-${name}`)
          copyFileSync(src, dest)
          out.push({ id, name, mimeType: mimeFor(name), path: dest, bytes: statSync(dest).size })
        } catch (e) {
          ctx.toast('error', `Could not add ${basename(src)}: ${(e as Error).message}`)
        }
      }
      return out
    },
    'profile:draft': async (source) => {
      try {
        let parts: Part[]
        if (source.kind === 'text') parts = [{ text: source.text }]
        else if (source.kind === 'session') {
          const s = sessions.get(source.id)
          const text = s ? sessionSelfText(s) : ''
          if (!text) throw new Error('You did not say anything in this session.')
          parts = [{ text }]
        } else {
          const files = await pickProfileFiles(windows.app)
          if (!files.length) return ''
          const used = briefParts(files)
          if (!used.parts.length) throw new Error(`Couldn't read ${used.skipped.join(', ')}.`)
          parts = used.parts
        }
        return await draftProfile(
          ctx.llm(),
          settings.value.models.deep,
          settings.value.profile,
          parts
        )
      } catch (e) {
        const msg = errorMessage(e)
        throw new Error(msg, { cause: e })
      }
    },
    'cue:ask': (q) => {
      if (needSession()) void engine.director.ask(q)
    },
    'cue:screen': async () => {
      if (needSession()) await screenCue(ctx)
    },
    'cue:deeper': () => {
      if (needSession()) void engine.director.deeper()
    },
    'cue:show': (id) => {
      engine.deck.show(id)
      engine.changed()
    },
    'cue:step': (dir) => {
      engine.deck.step(dir)
      engine.changed()
    },
    'cue:pin': (on) => {
      engine.deck.pin(on)
      engine.changed()
    },
    'cue:setAuto': (on) => engine.setAutoCue(on),
    'settings:get': () => settings.value,
    'settings:set': (patch) => {
      const prev = settings.value
      const next = settings.set(patch)
      ctx.settingsChanged(prev)
      return next
    },
    'permissions:check': () =>
      checkPermissions(ctx.llm, settings.value, engine.state.audio.system === 'denied'),
    'permissions:open': (which) => openPermissionPane(which),
    'audio:test': (on) => engine.setTest(on),
    'window:setMode': (mode) =>
      windows.setMode(mode, engine.state.session === 'live' || engine.state.session === 'paused'),
    'window:toggleOverlay': () => windows.toggleOverlay(),
    'window:getMode': () => windows.mode
  }

  for (const [channel, fn] of Object.entries(api)) {
    ipcMain.handle(channel, (_e, ...args: unknown[]) =>
      (fn as (...a: unknown[]) => unknown)(...args)
    )
  }
}
