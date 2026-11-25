// Sidekick main process: owns all state; windows only render LiveState and call Api.
import { app, globalShortcut, systemPreferences } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import type { HotkeyId, Settings } from '../shared/types'
import { Engine } from './engine'
import { loadEnvLocal, readEnvFile } from './env'
import { registerHotkeys } from './hotkeys'
import { copyNext, recap, registerIpc, screenCue, type AppCtx } from './ipc'
import { errorMessage, makeLlm, type Llm } from './llm'
import { fileLogger } from './logfile'
import { SessionStore } from './sessions'
import { SettingsStore, defaultSettings } from './settings'
import { Windows } from './windows'

const dev = !app.isPackaged
// Personal tool: the packaged app seeds empty Vertex settings from the dev checkout's .env.local.
const DEV_CHECKOUT_ENV_FILE = join(homedir(), 'proj/copilot/.env.local')
// Dev and the packaged app share one data folder (settings, sessions, log).
// SIDEKICK_DATA=<dir> gives a dev run its own data folder, so it can run next to the installed app.
app.setPath('userData', process.env.SIDEKICK_DATA || join(app.getPath('appData'), 'sidekick'))
if (dev) loadEnvLocal(app.getAppPath())
const fileLog = fileLogger(join(app.getPath('userData'), 'sidekick.log'))
const log = (m: string): void => {
  console.log(`[sidekick] ${m}`)
  fileLog(`[sidekick] ${m}`)
}

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
  if (!dev && !settings.value.vertex.project) {
    const env = readEnvFile(DEV_CHECKOUT_ENV_FILE)
    if (env.GOOGLE_CLOUD_PROJECT) {
      settings.set({
        vertex: {
          project: env.GOOGLE_CLOUD_PROJECT,
          location: env.GOOGLE_CLOUD_LOCATION || 'global',
          credentialsPath: env.GOOGLE_APPLICATION_CREDENTIALS ?? ''
        }
      })
      log(`seeded Vertex settings from ${DEV_CHECKOUT_ENV_FILE}`)
    }
  }
  const v = settings.value.vertex
  log(
    `start v${app.getVersion()} ${dev ? 'dev' : 'packaged'} · data ${userData} · vertex ${
      v.project ? `project set, location ${v.location || 'global'}` : 'NOT configured'
    }, key file ${v.credentialsPath && existsSync(v.credentialsPath) ? 'found' : 'missing'}`
  )
  const mediaStatus = (): string =>
    `microphone ${systemPreferences.getMediaAccessStatus('microphone')}, screen ${systemPreferences.getMediaAccessStatus('screen')}`
  log(`permissions: ${mediaStatus()}`)

  let llm: Llm | null = null
  const getLlm = (): Llm => (llm ??= makeLlm(settings.value.vertex))

  const lastToast = new Map<string, number>() // text → sent at; the same text at most once per 30 s
  const toast = (kind: 'info' | 'error', text: string): void => {
    const now = Date.now()
    if (now - (lastToast.get(text) ?? 0) < 30_000) return
    lastToast.set(text, now)
    if (kind === 'error') log(`error: ${text}`)
    windows.broadcast('toast', { kind, text })
  }

  // A window that throws or dies shows up blank with no other trace: put it in the log.
  app.on('web-contents-created', (_e, wc) => {
    wc.on('console-message', (_ev, level, message, line, source) => {
      if (level >= 3) log(`window error: ${message} (${source.split('/').pop()}:${line})`)
    })
    wc.on('render-process-gone', (_ev, d) => log(`window process gone: ${d.reason}`))
  })
  const windows = new Windows(settings, () => {
    log(`action overlay moved or resized ${JSON.stringify(settings.value.overlay.bounds)}`)
    windows.broadcast('settings', settings.value)
  })
  let onScreen = '' // which card is active and which is queued, as last logged
  const fakeDir = process.env.SIDEKICK_FAKE_AUDIO
  if (fakeDir) log(`fake audio from ${fakeDir}`)

  const engine = new Engine({
    llm: getLlm,
    settings: () => settings.value,
    bin: dev
      ? join(app.getAppPath(), 'resources/bin/audiocap')
      : join(process.resourcesPath, 'bin/audiocap'),
    fakeDir,
    emitLive: (s) => {
      // when each card actually reached the user, which the cue lines alone do not say
      const label = (id: string | null): string => {
        const c = s.cards.find((x) => x.id === id)
        return c ? `"${c.sections.at(-1)?.prompt || c.source}"` : 'none'
      }
      const now = `card on screen: ${label(s.activeCardId)}, queued: ${label(s.queuedCardId)}${s.pinned ? ', pinned' : ''}`
      if (now !== onScreen && s.session !== 'idle') log((onScreen = now))
      windows.broadcast('live', s)
    },
    emitLevels: (l) => windows.broadcast('levels', l),
    toast,
    log,
    onUtterance: (u) => log(`utterance ${u.speaker}: ${u.text}`),
    granted: (key) =>
      systemPreferences.getMediaAccessStatus(key === 'mic' ? 'microphone' : 'screen') === 'granted',
    onRun: (r) => {
      const lat =
        r.firstLineAt && r.speechEndAt
          ? ` ${r.firstLineAt - r.speechEndAt} ms after speech end`
          : r.firstLineAt
            ? ` first text after ${r.firstLineAt - r.startedAt} ms, done after ${(r.endedAt ?? r.firstLineAt) - r.startedAt} ms`
            : ''
      log(
        `cue ${r.kind} → ${r.outcome}${r.reason ? ` [${r.reason}]` : ''}${lat}${r.say ? `: ${r.say}` : ''}${r.error ? ` (${r.error})` : ''}`
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
    screen: () => isLive() && void screenCue(ctx),
    deeper: () => isLive() && void engine.director.deeper(),
    prevCard: () => (engine.deck.step(-1), engine.changed()),
    nextCard: () => (engine.deck.step(1), engine.changed()),
    pin: () => (engine.deck.pin(!engine.state.pinned), engine.changed()),
    copy: () => copyNext(ctx),
    toggleOverlay: () => windows.toggleOverlay(),
    toggleMode: () => windows.setMode(windows.mode === 'app' ? 'overlay' : 'app', isLive()),
    toggleListening: () => isLive() && engine.pause(engine.state.session === 'live')
  }
  const applyHotkeys = (): void => {
    const logged = Object.fromEntries(
      Object.entries(actions).map(([id, run]) => [id, () => (log(`action hotkey ${id}`), run())])
    ) as typeof actions
    const failed = registerHotkeys(settings.value.hotkeys, logged)
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
    log,
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
      // the last words were still being transcribed: save again once they land, then recap
      const id = engine.state.sessionId
      void engine.settled(5000).then(() => {
        if (engine.state.sessionId !== id) return // a new session started meanwhile
        save()
        if (id && engine.state.utterances.length)
          recap(ctx, id).catch((e) => toast('error', `Recap failed: ${errorMessage(e)}`))
      })
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
      for (const [name, w] of [
        ['app', windows.app],
        ['overlay', windows.overlay]
      ] as const) {
        if (!w || w.isDestroyed() || !w.isVisible()) continue
        const img = await w.webContents.capturePage().catch(() => null)
        if (img)
          writeFileSync(join(shotsDir, `${name}-${String(n).padStart(2, '0')}.png`), img.toPNG())
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
