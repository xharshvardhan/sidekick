// App window + overlay panel, window mode, and event broadcast to both.
import { BrowserWindow, screen, shell } from 'electron'
import { join } from 'path'
import { OVERLAY_MIN, type Events, type WindowMode } from '../shared/types'
import { overlayBounds } from './placement'
import type { SettingsStore } from './settings'

export class Windows {
  app: BrowserWindow | null = null
  overlay: BrowserWindow | null = null
  mode: WindowMode = 'app'
  quitting = false
  private loaded = new Set<BrowserWindow>()
  private early: { event: keyof Events; payload: unknown }[] = [] // toasts sent before any window loaded
  private boundsTimer: NodeJS.Timeout | null = null

  constructor(
    private settings: SettingsStore,
    private onSettingsChanged: () => void
  ) {}

  private webPreferences(): Electron.WebPreferences {
    return {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true
    }
  }

  private load(win: BrowserWindow, route: string): void {
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https:\/\//.test(url)) shell.openExternal(url)
      return { action: 'deny' }
    })
    // no remote content: block navigation away from the bundle
    win.webContents.on('will-navigate', (e, url) => {
      if (!url.startsWith(process.env['ELECTRON_RENDERER_URL'] ?? 'file://')) e.preventDefault()
    })
    win.webContents.on('did-finish-load', () => {
      this.loaded.add(win)
      for (const m of this.early.splice(0)) this.send(win, m.event, m.payload)
    })
    win.on('closed', () => this.loaded.delete(win))
    const dev = process.env['ELECTRON_RENDERER_URL']
    if (dev) win.loadURL(`${dev}#${route}`)
    else win.loadFile(join(__dirname, '../renderer/index.html'), { hash: route })
  }

  createApp(): BrowserWindow {
    const win = new BrowserWindow({
      width: 1100,
      height: 740,
      minWidth: 880,
      minHeight: 600,
      show: false,
      title: 'Sidekick',
      titleBarStyle: 'hiddenInset',
      webPreferences: this.webPreferences()
    })
    win.on('ready-to-show', () => {
      if (this.mode === 'app') win.show()
    })
    // closing the app window hides it; state lives in main, so nothing is lost
    win.on('close', (e) => {
      if (this.quitting) return
      e.preventDefault()
      win.hide()
    })
    this.load(win, '/home')
    this.app = win
    return win
  }

  createOverlay(): BrowserWindow {
    const bounds = overlayBounds(
      this.settings.value.overlay.bounds,
      screen.getAllDisplays().map((d) => d.bounds),
      screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea
    )
    const win = new BrowserWindow({
      ...bounds,
      type: 'panel', // NSPanel: floats without taking focus from the call app
      frame: false,
      vibrancy: 'hud',
      visualEffectState: 'active',
      transparent: false,
      hasShadow: true,
      // Native edges show a resize cursor, which screen recordings pick up: the page has its own edge handles.
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      minWidth: OVERLAY_MIN.width,
      minHeight: OVERLAY_MIN.height,
      show: false,
      webPreferences: this.webPreferences()
    })
    win.setAlwaysOnTop(true, 'floating')
    // skipTransformProcessType keeps the dock icon (the default would turn the app into a UI element)
    win.setVisibleOnAllWorkspaces(true, {
      visibleOnFullScreen: true,
      skipTransformProcessType: true
    })
    this.applyOverlaySettings(win)
    const save = (): void => {
      if (this.boundsTimer) clearTimeout(this.boundsTimer)
      this.boundsTimer = setTimeout(() => {
        if (win.isDestroyed()) return
        this.settings.set({ overlay: { bounds: win.getBounds() } })
        this.onSettingsChanged()
      }, 500)
    }
    win.on('moved', save)
    win.on('resize', save)
    win.on('close', (e) => {
      if (this.quitting) return
      e.preventDefault()
      win.hide()
    })
    this.load(win, '/overlay')
    this.overlay = win
    return win
  }

  applyOverlaySettings(win = this.overlay): void {
    if (!win || win.isDestroyed()) return
    const o = this.settings.value.overlay
    win.setContentProtection(o.hideFromScreenShare)
    win.setOpacity(Math.max(0.6, Math.min(1, o.opacity)))
  }

  /** Run a screen capture with Sidekick's own windows left out of it, without hiding them (no flicker). */
  async hiddenFromCapture<T>(capture: () => Promise<T>): Promise<T> {
    const wins = [this.app, this.overlay].filter((w): w is BrowserWindow => !!w && !w.isDestroyed())
    for (const w of wins) w.setContentProtection(true)
    try {
      await new Promise((r) => setTimeout(r, 120)) // let the window server apply it
      return await capture()
    } finally {
      this.app?.isDestroyed() === false && this.app.setContentProtection(false)
      this.applyOverlaySettings()
    }
  }

  showOverlay(on: boolean): void {
    const w = this.overlay
    if (!w || w.isDestroyed()) return
    if (on) w.showInactive()
    else w.hide()
  }

  toggleOverlay(): void {
    this.showOverlay(!this.overlay?.isVisible())
  }

  /** app: app window shown, overlay while live (if showOnStart). overlay: overlay only. */
  setMode(mode: WindowMode, live: boolean): void {
    this.mode = mode
    if (mode === 'overlay') {
      this.app?.hide()
      this.showOverlay(true)
    } else {
      this.app?.show()
      this.app?.focus()
      this.showOverlay(live && this.settings.value.overlay.showOnStart)
    }
    this.broadcast('mode', mode)
  }

  broadcast<K extends keyof Events>(event: K, payload: Events[K]): void {
    const wins = [this.app, this.overlay].filter((w): w is BrowserWindow => !!w && !w.isDestroyed())
    const ready = wins.filter((w) => this.loaded.has(w))
    if (!ready.length && event === 'toast') this.early.push({ event, payload })
    for (const w of ready) this.send(w, event, payload)
  }

  private send(win: BrowserWindow, event: keyof Events, payload: unknown): void {
    if (!win.isDestroyed()) win.webContents.send(event, payload)
  }
}
