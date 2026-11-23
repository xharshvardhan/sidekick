// In-renderer fake of the main process, used with ?demo=1 / ?demo=empty or when no preload bridge exists.
import type {
  Api,
  Card,
  CardSection,
  Events,
  LiveState,
  Session,
  Settings,
  WindowMode
} from '../../../shared/types'
import { demoNoProfile, demoStress, demoToast, type Bridge } from '../bridge'
import {
  demoProfile,
  demoRecap,
  sectionLimiter,
  sectionRegions,
  seedLive,
  seedPermissions,
  seedSessions,
  seedSettings,
  stressLive,
  stressSessions,
  stressText
} from './seed'

type Handlers = { [K in keyof Api]: (...args: Parameters<Api[K]>) => ReturnType<Api[K]> }

function merge<T>(base: T, patch: unknown): T {
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) return patch as T
  const out = { ...(base as Record<string, unknown>) }
  for (const [k, v] of Object.entries(patch)) out[k] = merge(out[k], v)
  return out as T
}

export function createDemoBridge(variant: string, scene: string): Bridge {
  const fresh = variant === 'empty'
  const animated = !scene && !fresh
  let settings: Settings = seedSettings(fresh)
  if (demoNoProfile) settings = { ...settings, profile: '' }
  const q = new URLSearchParams(location.search) // demo-only overrides: ?fontscale=1.3&opacity=0.6
  if (q.has('fontscale') || q.has('opacity'))
    settings = merge(settings, {
      overlay: {
        fontScale: Number(q.get('fontscale') ?? 1),
        opacity: Number(q.get('opacity') ?? 1)
      }
    })
  let live: LiveState = seedLive(scene || 'queued', fresh)
  let sessions: Session[] = fresh ? [] : seedSessions()
  let permissions = seedPermissions(fresh)
  if (demoStress) {
    live = stressLive(live)
    if (!fresh) sessions = stressSessions()
    permissions = {
      ...permissions,
      vertex: { ok: false, message: stressText.error }
    }
  }
  if (demoToast) setTimeout(() => emit('toast', { kind: 'error', text: stressText.error }), 400)
  let mode: WindowMode = 'app'
  let audioTest = false
  const listeners = new Map<keyof Events, Set<(p: never) => void>>()

  function emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    listeners.get(event)?.forEach((fn) => (fn as (p: Events[K]) => void)(payload))
  }
  function setLive(patch: Partial<LiveState>): void {
    live = { ...live, ...patch }
    emit('live', live)
  }
  function patchCard(id: string, fn: (c: Card) => Card): void {
    setLive({ cards: live.cards.map((c) => (c.id === id ? fn(c) : c)) })
  }

  // Levels: moving in animated mode, fixed in screenshot scenes so PNGs are stable.
  let t = 0
  setInterval(() => {
    t++
    const on = live.session === 'live' || audioTest
    if (!on) return emit('levels', { you: 0, them: 0 })
    if (!animated)
      return emit(
        'levels',
        audioTest
          ? { you: 0.3, them: 0.18 }
          : { you: live.partial.you ? 0.55 : 0.08, them: live.partial.them ? 0.6 : 0.06 }
      )
    const wave = (k: number): number =>
      Math.max(0, Math.min(1, 0.35 + 0.3 * Math.sin(t / k) + 0.25 * Math.random()))
    emit('levels', {
      you: live.partial.you ? wave(3) : 0.05 * Math.random(),
      them: live.partial.them || audioTest ? wave(4) : 0.05 * Math.random()
    })
  }, 125)

  // Animated default: replay the "across regions" follow-up streaming into the rate-limiter card.
  if (animated) {
    const steps: (() => void)[] = []
    const blank: CardSection = { ...sectionRegions, prompt: '', say: '', points: [], detail: '' }
    const sec = (s: Partial<CardSection>): void =>
      patchCard('c2', (c) => ({ ...c, sections: [sectionLimiter, { ...c.sections[1], ...s }] }))
    steps.push(() => {
      setLive({ partial: { you: false, them: true }, thinking: false })
      patchCard('c2', (c) => ({ ...c, status: 'done', sections: [sectionLimiter] }))
    })
    steps.push(() => setLive({ partial: { you: false, them: false }, thinking: true }))
    steps.push(() =>
      patchCard('c2', (c) => ({ ...c, status: 'streaming', sections: [sectionLimiter, blank] }))
    )
    const words = sectionRegions.say.split(' ')
    words.forEach((_, i) => steps.push(() => sec({ say: words.slice(0, i + 1).join(' ') })))
    steps.push(() => setLive({ thinking: false }))
    sectionRegions.points.forEach((_, i) =>
      steps.push(
        () =>
          sec({
            points: sectionRegions.points.slice(0, i + 1).map((p) => ({ ...p, covered: false }))
          }),
        () => {}
      )
    )
    steps.push(() => sec({ prompt: sectionRegions.prompt }))
    steps.push(() => sec({ detail: sectionRegions.detail }))
    steps.push(() => {
      patchCard('c2', (c) => ({ ...c, status: 'done' }))
      setLive({ partial: { you: true, them: false } })
    })
    steps.push(() => sec({ points: sectionRegions.points }))
    for (let i = 0; i < 40; i++) steps.push(() => {})
    let i = 0
    setInterval(() => {
      if (live.session !== 'live' || live.activeCardId !== 'c2') return
      steps[i++ % steps.length]()
    }, 150)
  }

  const handlers: Handlers = {
    'live:get': () => live,
    'session:start': (brief) => {
      const next = seedLive('queued', false)
      setLive({ ...next, title: brief.title || 'Untitled session', startedAt: Date.now() })
      return { sessionId: next.sessionId ?? 'live-1' }
    },
    'session:end': () => {
      const ended: Session = {
        id: `s-${Date.now()}`,
        title: live.title,
        preset: 'interview',
        startedAt: live.startedAt ?? Date.now(),
        endedAt: Date.now(),
        utteranceCount: live.utterances.length,
        cardCount: live.cards.length,
        brief: { title: live.title, preset: 'interview', notes: '', files: [] },
        utterances: live.utterances,
        cards: live.cards,
        summary: ''
      }
      sessions = [ended, ...sessions]
      setLive(seedLive('none', true))
    },
    'session:pause': (paused) => setLive({ session: paused ? 'paused' : 'live' }),
    'session:list': () =>
      sessions.map(
        ({ brief: _b, utterances: _u, cards: _c, summary: _s, recap: _r, ...meta }) => meta
      ),
    'session:get': (id) => sessions.find((s) => s.id === id) ?? null,
    'session:delete': (id) => {
      sessions = sessions.filter((s) => s.id !== id)
    },
    'session:recap': (id) => {
      sessions = sessions.map((s) => (s.id === id ? { ...s, recap: demoRecap } : s))
      return demoRecap
    },
    'brief:pickFiles': () => [
      {
        id: `f${Date.now()}`,
        name: 'Priya_Raman_Resume.pdf',
        mimeType: 'application/pdf',
        path: '/demo/resume.pdf',
        bytes: 182_400
      }
    ],
    'profile:draft': (source) =>
      new Promise<string>((r) =>
        setTimeout(
          () => r(source.kind === 'files' || source.kind === 'text' ? demoProfile : ''),
          600
        )
      ) as never,
    'cue:ask': () => setLive({ thinking: true }),
    'cue:screen': () => setLive({ thinking: true }),
    'cue:deeper': () => emit('toast', { kind: 'info', text: 'Going deeper on this card…' }),
    'cue:show': (cardId) =>
      setLive({
        activeCardId: cardId,
        queuedCardId: live.queuedCardId === cardId ? null : live.queuedCardId
      }),
    'cue:step': (dir) => {
      if (dir === 1 && live.queuedCardId)
        return setLive({ activeCardId: live.queuedCardId, queuedCardId: null })
      const i = live.cards.findIndex((c) => c.id === live.activeCardId)
      const next = live.cards[Math.max(0, Math.min(live.cards.length - 1, i + dir))]
      if (next) setLive({ activeCardId: next.id })
    },
    'cue:pin': (pinned) => setLive({ pinned }),
    'cue:setAuto': (on) => setLive({ autoCue: on }),
    'settings:get': () => settings,
    'settings:set': (patch) => {
      settings = merge(settings, patch)
      emit('settings', settings)
      return settings
    },
    'permissions:check': () => permissions,
    'permissions:open': (which) => {
      setTimeout(() => {
        permissions = { ...permissions, [which]: 'granted' }
      }, 1500)
    },
    'audio:test': (on) => {
      audioTest = on
    },
    'window:setMode': (m) => {
      mode = m
      emit('mode', m)
    },
    'window:toggleOverlay': () => emit('toast', { kind: 'info', text: 'Overlay toggled (demo)' }),
    'window:getMode': () => mode,
    'overlay:setBounds': () => {}
  }

  return {
    invoke(channel, ...args) {
      const fn = handlers[channel] as (...a: typeof args) => ReturnType<Api[typeof channel]>
      return new Promise((resolve) => setTimeout(() => resolve(fn(...args)), 30))
    },
    on(event, fn) {
      const set = listeners.get(event) ?? new Set()
      listeners.set(event, set)
      set.add(fn)
      return () => set.delete(fn)
    }
  }
}
