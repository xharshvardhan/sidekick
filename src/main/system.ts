// macOS integrations: permission checks, System Settings panes, screenshots.
import { desktopCapturer, screen, shell, systemPreferences } from 'electron'
import type { Permissions, Settings } from '../shared/types'
import { errorMessage, generateText, type Llm } from './llm'

type Status = Permissions['microphone']

const map = (s: string): Status =>
  s === 'granted' ? 'granted' : s === 'denied' || s === 'restricted' ? 'denied' : 'unknown'

export async function checkPermissions(
  llm: () => Llm,
  settings: Settings,
  systemDenied: boolean
): Promise<Permissions> {
  let mic = systemPreferences.getMediaAccessStatus('microphone')
  if (mic === 'not-determined')
    mic = (await systemPreferences.askForMediaAccess('microphone')) ? 'granted' : 'denied'
  const scr = map(systemPreferences.getMediaAccessStatus('screen'))
  return {
    microphone: map(mic),
    // the audio helper is the real test: if it reported a TCC failure, the permission is missing
    screen: systemDenied ? 'denied' : scr,
    vertex: await testVertex(llm, settings)
  }
}

async function testVertex(llm: () => Llm, s: Settings): Promise<Permissions['vertex']> {
  if (!s.vertex.project)
    return { ok: false, message: 'Set the Vertex project in Settings → Vertex.' }
  const t = Date.now()
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 15_000)
    const text = await generateText(llm(), {
      model: s.models.cue,
      parts: [{ text: 'Reply with the word OK.' }],
      signal: ctrl.signal,
      maxTokens: 5
    })
    clearTimeout(timer)
    return {
      ok: true,
      message: `Connected (${s.models.cue} replied "${text.trim()}" in ${Date.now() - t} ms)`
    }
  } catch (e) {
    return { ok: false, message: errorMessage(e) }
  }
}

/** Ask macOS first (shows its prompt and lists Sidekick in System Settings), then open the pane. */
export async function openPermissionPane(which: 'microphone' | 'screen'): Promise<void> {
  if (which === 'microphone') {
    if (await systemPreferences.askForMediaAccess('microphone')) return
  } else {
    // a capture attempt is what registers the app for Screen Recording
    await desktopCapturer
      .getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } })
      .catch(() => [])
  }
  const pane = which === 'microphone' ? 'Privacy_Microphone' : 'Privacy_ScreenCapture'
  await shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?${pane}`)
}

/** Screenshot of the display under the cursor as base64 JPEG, longest side ≤ 1600 px. */
export async function screenshot(): Promise<string> {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  const { width, height } = display.size
  const k =
    Math.min(1, 1600 / Math.max(width * display.scaleFactor, height * display.scaleFactor)) *
    display.scaleFactor
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: Math.round(width * k), height: Math.round(height * k) }
  })
  const src = sources.find((s) => s.display_id === String(display.id)) ?? sources[0]
  if (!src || src.thumbnail.isEmpty())
    throw new Error('Screen capture returned nothing. Grant Screen Recording in Setup.')
  return src.thumbnail.toJPEG(80).toString('base64')
}
