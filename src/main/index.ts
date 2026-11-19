// Sidekick main process: owns all state; windows only render LiveState and call Api.
import { app, globalShortcut, systemPreferences } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { HotkeyId, Settings } from '../shared/types'
import { Engine } from './engine'
import { loadEnvLocal } from './env'
import { registerHotkeys } from './hotkeys'
import { recap, registerIpc, screenCue, type AppCtx } from './ipc'
import { errorMessage, makeLlm, type Llm } from './llm'
import { SessionStore } from './sessions'
import { SettingsStore, defaultSettings } from './settings'
import { Windows } from './windows'

const dev = !app.isPackaged
if (dev) loadEnvLocal(app.getAppPath())
const log = (m: string): void => console.log(`[sidekick] ${m}`)

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.whenReady().then(main)
}

function main(): void {
  app.setName('Sidekick')
  const userData = app.getPath('userData')
  const settings = new SettingsStore(
    join(userData, 'settings.json'),
    defaultSettings(dev ? process.env : {})
  )
  const sessions = new SessionStore(join(userData, 'sessions'))

  let llm: Llm | null = null
  const getLlm = (): Llm => (llm ??= makeLlm(settings.value.vertex))

  const toast = (kind: 'info' | 'error', text: string): void => {
    if (kind === 'error') log(`error: ${text}`)
    windows.broadcast('toast', { kind, text })
  }

  const windows = new Windows(settings, () => windows.broadcast('settings', settings.value))
  const fakeDir = process.env.SIDEKICK_FAKE_AUDIO
  if (fakeDir) log(`fake audio from ${fakeDir}`)

  const engine = new Engine({
    llm: getLlm,
    settings: () => settings.value,
    bin: dev
      ? join(app.getAppPath(), 'resources/bin/audiocap')
      : join(process.resourcesPath, 'bin/audiocap'),
    fakeDir,
    emitLive: (s) => windows.broadcast('live', s),
    emitLevels: (l) => windows.broadcast('levels', l),
    toast,
    log,
    onUtterance: (u) => log(`utterance ${u.speaker}: ${u.text}`),
    micGranted: () => systemPreferences.getMediaAccessStatus('microphone') === 'granted',
    onRun: (r) => {
      const lat =
        r.firstLineAt && r.speechEndAt
          ? ` ${r.firstLineAt - r.speechEndAt} ms after speech end`
          : ''
      log(
        `cue ${r.kind} → ${r.outcome}${lat}${r.say ? `: ${r.say}` : ''}${r.error ? ` (${r.error})` : ''}`
      )
    }
  })

  const isLive = (): boolean => engine.state.session === 'live' || engine.state.session === 'paused'
  let autosave: NodeJS.Timeout | null = null
  const save = (): void => {
    const snap = engine.snapshot()
    if (!snap) return
    try {
      sessions.save({ ...snap, recap: sessions.get(snap.id)?.recap })
    } catch (e) {
      toast('error', `Could not save the session: ${(e as Error).message}`)
    }
  }

  const actions: Record<HotkeyId, () => void> = {
    ask: () => isLive() && void engine.director.ask(''),
    screen: () => isLive() && void screenCue(engine),
    deeper: () => isLive() && void engine.director.deeper(),
    prevCard: () => (engine.deck.step(-1), engine.changed()),
    nextCard: () => (engine.deck.step(1), engine.changed()),
    pin: () => (engine.deck.pin(!engine.state.pinned), engine.changed()),
    toggleOverlay: () => windows.toggleOverlay(),
    toggleMode: () => windows.setMode(windows.mode === 'app' ? 'overlay' : 'app', isLive()),
    toggleListening: () => isLive() && engine.pause(engine.state.session === 'live')
  }
  const applyHotkeys = (): void => {
    const failed = registerHotkeys(settings.value.hotkeys, actions)
    if (failed.length)
      toast('error', `Hotkeys not registered (in use by another app?): ${failed.join(', ')}`)
  }

  const ctx: AppCtx = {
    engine,
    settings,
    sessions,
    windows,
    llm: getLlm,
    filesDir: join(userData, 'files'),
    toast,
    settingsChanged: (prev: Settings) => {
      const next = settings.value
      if (JSON.stringify(prev.vertex) !== JSON.stringify(next.vertex)) llm = null
      if (JSON.stringify(prev.hotkeys) !== JSON.stringify(next.hotkeys)) applyHotkeys()
      windows.applyOverlaySettings()
      engine.settingsChanged(prev, next)
      windows.broadcast('settings', next)
    },
    sessionStarted: () => {
      save()
      if (autosave) clearInterval(autosave)
      autosave = setInterval(save, 10_000)
      if (windows.mode === 'overlay' || settings.value.overlay.showOnStart)
        windows.showOverlay(true)
    },
    sessionEnded: () => {
      if (!isLive()) return
      engine.end()
      if (autosave) clearInterval(autosave)
      autosave = null
      save()
      windows.showOverlay(false)
      if (windows.mode === 'overlay') windows.setMode('app', false)
      const id = engine.state.sessionId
      if (id && engine.state.utterances.length)
        recap(ctx, id).catch((e) => toast('error', `Recap failed: ${errorMessage(e)}`))
    }
  }

  registerIpc(ctx)
  windows.createApp()
  windows.createOverlay()
  applyHotkeys()

  // dev: start a session right away from a brief file (SIDEKICK_AUTOSTART=<brief.json>, real audio)
  // or from the brief.json that `npm run sim` writes next to fake audio.
  const fakeBrief = fakeDir && join(fakeDir, 'brief.json')
  const autoBrief =
    process.env.SIDEKICK_AUTOSTART || (fakeBrief && existsSync(fakeBrief) ? fakeBrief : '')
  if (dev && autoBrief) {
    windows.app?.webContents.once('did-finish-load', () => {
      engine.start(JSON.parse(readFileSync(autoBrief, 'utf8')))
      ctx.sessionStarted()
      log('dev session started')
    })
  }
  // dev: SIDEKICK_SHOTS=<dir> saves a PNG of both windows every 3 s, to review the real UI
  const shotsDir = dev && process.env.SIDEKICK_SHOTS
  if (shotsDir) {
    let n = 0
    setInterval(async () => {
      n++
      for (const [name, w] of [['app', windows.app], ['overlay', windows.overlay]] as const) {
        if (!w || w.isDestroyed() || !w.isVisible()) continue
        const img = await w.webContents.capturePage().catch(() => null)
        if (img) writeFileSync(join(shotsDir, `${name}-${String(n).padStart(2, '0')}.png`), img.toPNG())
      }
    }, 3000)
  }

  app.on('second-instance', () => windows.setMode('app', isLive()))
  app.on('activate', () => {
    if (windows.mode === 'app') windows.app?.show()
  })
  app.on('before-quit', () => {
    windows.quitting = true
    ctx.sessionEnded()
    engine.setTest(false)
  })
  app.on('will-quit', () => globalShortcut.unregisterAll())
  process.on('uncaughtException', (e) => {
    log(`uncaught: ${e.stack ?? e}`)
    toast('error', `Internal error: ${e.message}`)
  })
  process.on('unhandledRejection', (e) => {
    log(`unhandled rejection: ${String((e as Error)?.stack ?? e)}`)
    toast('error', `Internal error: ${(e as Error)?.message ?? String(e)}`)
  })
}
