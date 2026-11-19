// Implements every `Api` channel on ipcMain.handle.
import { BrowserWindow, dialog, ipcMain } from 'electron'
import { copyFileSync, mkdirSync, statSync } from 'fs'
import { basename, join } from 'path'
import type { Api, BriefFile, Recap } from '../shared/types'
import type { Engine } from './engine'
import { newId } from './director/cards'
import { mimeFor } from './director/brief'
import { errorMessage, type Llm } from './llm'
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

/** Take a screenshot and ask the director about it; failures become an error card. */
export async function screenCue(engine: Engine): Promise<void> {
  try {
    const jpeg = await screenshot()
    void engine.director.screen(jpeg)
  } catch (e) {
    engine.deck.addError('screen', (e as Error).message, Date.now())
    engine.changed()
  }
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
      const sessionId = engine.start(brief)
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
    'cue:ask': (q) => {
      if (needSession()) void engine.director.ask(q)
    },
    'cue:screen': async () => {
      if (needSession()) await screenCue(engine)
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
