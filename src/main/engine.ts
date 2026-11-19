// The headless core: audio → segmenter → STT → conversation → director → cards, all in LiveState.
// No Electron imports: the app wraps it with windows/IPC, the sim drives it directly.
import { join } from 'path'
import type { Brief, LiveState, Session, Settings, Speaker, Utterance } from '../shared/types'
import { fakeCapture, spawnCapture, type Capture, type CaptureStatus } from './audio/capture'
import { Segmenter, type Segment } from './audio/segmenter'
import { isEcho } from './audio/echo'
import { pcmToWav, samplesToMs } from './audio/wav'
import { Conversation } from './convo'
import { Deck, newId, type UserActivity } from './director/cards'
import { Director, type RunRecord } from './director/director'
import { briefParts } from './director/brief'
import { errorMessage, type Llm } from './llm'
import { transcribe } from './stt'

export interface EngineDeps {
  llm(): Llm
  settings(): Settings
  bin: string // path to audiocap
  fakeDir?: string // SIDEKICK_FAKE_AUDIO: play you.pcm / them.pcm instead of capturing
  fakeStartAt?: number // epoch ms the fake timelines start (sim)
  emitLive(s: LiveState): void
  emitLevels(l: { you: number; them: number }): void
  toast(kind: 'info' | 'error', text: string): void
  log(msg: string): void
  onRun?(r: RunRecord): void
  onUtterance?(u: Utterance): void
  /** macOS mic permission. A denied mic delivers zeros, which must not look like a wedged AEC unit. */
  micGranted?(): boolean
}

interface Channel {
  seg: Segmenter
  cap: Capture | null
  inflight: number
  queue: { id: string; seg: Segment }[]
  error: string
}

const STT_PARALLEL = 3
const LOUD_RMS = 300 // "the system channel has audio"
const ZERO_FALLBACK_MS = 3000

export function idleState(autoCue = true): LiveState {
  return {
    session: 'idle',
    sessionId: null,
    title: '',
    startedAt: null,
    utterances: [],
    partial: { you: false, them: false },
    levels: { you: 0, them: 0 },
    cards: [],
    activeCardId: null,
    queuedCardId: null,
    pinned: false,
    autoCue,
    thinking: false,
    audio: { mic: 'off', system: 'off', echoCancellation: true }
  }
}

export class Engine {
  state: LiveState
  brief: Brief | null = null
  convo: Conversation
  deck: Deck
  director: Director
  private ch: Record<Speaker, Channel>
  private pending = new Map<string, { speaker: Speaker; seg: Segment }>() // segments awaiting transcripts
  private lastYouEndAt = 0
  private testing = false
  private audioOn = false
  private noAecFallback = false
  private micZeroMs = 0
  private sysLoudAt = 0
  private timers: NodeJS.Timeout[] = []
  private levelsTimer: NodeJS.Timeout | null = null
  private fakeStart: number | null = null
  private emitTimer: NodeJS.Timeout | null = null
  private lastEmit = 0
  private sttErrorAt = 0

  constructor(private d: EngineDeps) {
    this.state = idleState(d.settings().autoCue)
    this.convo = new Conversation(this.state.utterances)
    this.deck = new Deck(this.state)
    this.director = this.makeDirector()
    this.ch = { you: this.makeChannel('you'), them: this.makeChannel('them') }
  }

  // ---------- session lifecycle ----------

  start(brief: Brief, id = newId('s')): string {
    this.stopSessionWork()
    const s = this.d.settings()
    this.state = {
      ...idleState(s.autoCue),
      session: 'live',
      sessionId: id,
      title: brief.title || 'Untitled call',
      startedAt: Date.now()
    }
    this.state.audio = { ...this.state.audio, echoCancellation: s.echoCancellation }
    this.convo = new Conversation(this.state.utterances)
    this.deck = new Deck(this.state)
    this.director = this.makeDirector()
    this.pending.clear()
    this.lastYouEndAt = 0
    this.brief = brief
    const { parts, skipped } = briefParts(brief.files)
    if (skipped.length)
      this.d.toast('error', `Some brief files were not used: ${skipped.join(', ')}`)
    this.director.setBrief(brief, parts)
    this.startAudio()
    this.timers.push(setInterval(() => this.tick(), 250))
    this.changed()
    return id
  }

  end(): void {
    if (this.state.session === 'idle' || this.state.session === 'ended') return
    this.stopSessionWork()
    this.state.session = 'ended'
    this.changed()
  }

  pause(paused: boolean): void {
    if (this.state.session !== 'live' && this.state.session !== 'paused') return
    if (paused) {
      this.director.cancelAll()
      if (!this.testing) this.stopAudio()
      this.state.session = 'paused'
    } else {
      this.state.session = 'live'
      this.startAudio()
    }
    this.state.partial = { you: false, them: false }
    this.changed()
  }

  /** Run capture without a session (Setup meters). */
  setTest(on: boolean): void {
    this.testing = on
    if (on) this.startAudio()
    else if (this.state.session !== 'live') this.stopAudio()
  }

  snapshot(): Session | null {
    const st = this.state
    if (!st.sessionId || !this.brief || !st.startedAt) return null
    return {
      id: st.sessionId,
      title: st.title,
      preset: this.brief.preset,
      startedAt: st.startedAt,
      endedAt: st.session === 'ended' ? Date.now() : undefined,
      utteranceCount: st.utterances.length,
      cardCount: st.cards.length,
      brief: this.brief,
      utterances: st.utterances,
      cards: st.cards,
      summary: this.convo.summary
    }
  }

  setAutoCue(on: boolean): void {
    this.state.autoCue = on
    this.changed()
  }

  /** Settings changed: pick up echo cancellation changes by restarting the mic. */
  settingsChanged(prev: Settings, next: Settings): void {
    if (prev.echoCancellation !== next.echoCancellation && this.audioOn) {
      this.noAecFallback = false
      this.state.audio.echoCancellation = next.echoCancellation
      this.restartMic()
    }
  }

  private stopSessionWork(): void {
    this.director.cancelAll()
    for (const t of this.timers) clearInterval(t)
    this.timers = []
    if (!this.testing) this.stopAudio()
    this.state.thinking = false
    this.state.partial = { you: false, them: false }
  }

  private tick(): void {
    if (this.deck.tick(this.activity())) this.changed()
  }

  activity(): UserActivity {
    return {
      now: Date.now(),
      youSpeaking: this.state.partial.you,
      lastYouSpeechAt: this.lastYouEndAt
    }
  }

  // ---------- state push ----------

  /** Throttled to ≤ 15 pushes per second. */
  changed(): void {
    if (this.emitTimer) return
    const wait = Math.max(0, 66 - (Date.now() - this.lastEmit))
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null
      this.lastEmit = Date.now()
      this.d.emitLive(this.state)
    }, wait)
  }

  private makeDirector(): Director {
    return new Director({
      state: this.state,
      deck: this.deck,
      llm: this.d.llm,
      settings: this.d.settings,
      context: () => ({
        summary: this.convo.summary,
        tail: this.convo.tail(),
        audio: [...this.pending.values()]
          .sort((a, b) => a.seg.startedAt - b.seg.startedAt)
          .slice(-8)
          .map((p) => ({ speaker: p.speaker, wav: pcmToWav(p.seg.pcm) }))
      }),
      activity: () => this.activity(),
      changed: () => this.changed(),
      toast: this.d.toast,
      onRun: this.d.onRun
    })
  }

  // ---------- audio ----------

  private get noAec(): boolean {
    return !this.d.settings().echoCancellation || this.noAecFallback
  }

  private makeChannel(speaker: Speaker): Channel {
    const seg = new Segmenter({
      onStart: () => this.onSpeechStart(speaker),
      onEnd: (s) => this.onSpeechEnd(speaker, s),
      onDrop: () => this.setPartial(speaker, false),
      // energy gate: without AEC, quiet mic "speech" while the speakers are loud is echo
      suppress:
        speaker === 'you'
          ? (r) =>
              this.noAec &&
              this.ch.them.seg.lastRms > LOUD_RMS &&
              r < 0.6 * this.ch.them.seg.lastRms
          : undefined
    })
    return { seg, cap: null, inflight: 0, queue: [], error: '' }
  }

  private startAudio(): void {
    if (this.audioOn) return
    this.audioOn = true
    this.startChannel('you')
    this.startChannel('them')
    this.levelsTimer = setInterval(() => {
      const levels = { you: this.ch.you.seg.takeLevel(), them: this.ch.them.seg.takeLevel() }
      this.state.levels = levels
      this.d.emitLevels(levels)
    }, 125)
  }

  private stopAudio(): void {
    if (!this.audioOn) return
    this.audioOn = false
    for (const sp of ['you', 'them'] as Speaker[]) {
      this.ch[sp].cap?.stop()
      this.ch[sp].cap = null
      this.ch[sp].seg.anchor(0)
    }
    if (this.levelsTimer) clearInterval(this.levelsTimer)
    this.levelsTimer = null
    this.fakeStart = null
    this.state.audio = { ...this.state.audio, mic: 'off', system: 'off' }
    this.d.emitLevels({ you: 0, them: 0 })
    this.changed()
  }

  private restartMic(): void {
    this.ch.you.cap?.stop()
    this.startChannel('you')
  }

  private startChannel(speaker: Speaker): void {
    const c = this.ch[speaker]
    const key = speaker === 'you' ? 'mic' : 'system'
    const handlers = {
      onReady: (at: number) => c.seg.anchor(at),
      onData: (pcm: Int16Array) => this.onData(speaker, pcm),
      onStatus: (status: CaptureStatus, message?: string) => {
        const was = this.state.audio[key]
        if (
          speaker === 'you' &&
          status === 'ok' &&
          !this.d.fakeDir &&
          this.d.micGranted?.() === false
        )
          status = 'denied'
        this.state.audio[key] = status
        c.error = status === 'ok' || status === 'starting' ? '' : (message ?? 'permission denied')
        this.updateAudioMessage()
        if ((status === 'error' || status === 'denied') && was !== status) {
          const what = speaker === 'you' ? 'Microphone' : 'Call audio'
          this.d.toast(
            'error',
            status === 'denied'
              ? `${what}: permission denied. Open Setup to fix it.`
              : `${what}: ${message}`
          )
          this.d.log(`audio ${key} ${status}: ${message}`)
        }
        this.changed()
      }
    }
    if (this.d.fakeDir) {
      // both channels share one start time so the timelines line up
      const at = this.fakeStart ?? (this.fakeStart = this.d.fakeStartAt ?? Date.now() + 200)
      c.cap = fakeCapture(join(this.d.fakeDir, `${speaker}.pcm`), handlers, at)
    } else {
      const args = speaker === 'them' ? [] : this.noAec ? ['mic', '--no-aec'] : ['mic']
      c.cap = spawnCapture(this.d.bin, args, handlers)
    }
  }

  private updateAudioMessage(): void {
    const parts = [
      this.noAecFallback
        ? 'Echo cancellation stopped responding, so the mic runs without it. Use headphones to avoid echo.'
        : '',
      this.ch.you.error && `Mic: ${this.ch.you.error}`,
      this.ch.them.error && `Call audio: ${this.ch.them.error}`
    ].filter(Boolean)
    this.state.audio.message = parts.length ? parts.join(' · ') : undefined
    this.state.audio.echoCancellation = !this.noAec
  }

  private onData(speaker: Speaker, pcm: Int16Array): void {
    const c = this.ch[speaker]
    c.seg.push(pcm)
    if (speaker === 'them') {
      if (c.seg.lastRms > LOUD_RMS) this.sysLoudAt = Date.now()
      return
    }
    // AEC fallback: a wedged voice-processing unit outputs exact zeros while the call has audio.
    if (this.d.fakeDir || this.noAec || this.d.micGranted?.() === false) return
    if (pcm.every((v) => v === 0)) this.micZeroMs += samplesToMs(pcm.length)
    else this.micZeroMs = 0
    if (this.micZeroMs >= ZERO_FALLBACK_MS && Date.now() - this.sysLoudAt < ZERO_FALLBACK_MS) {
      this.micZeroMs = 0
      this.noAecFallback = true
      this.d.log('mic silent with AEC while call audio plays: restarting mic without AEC')
      this.updateAudioMessage()
      this.restartMic()
      this.changed()
    }
  }

  private setPartial(speaker: Speaker, on: boolean): void {
    if (this.state.partial[speaker] === on) return
    this.state.partial = { ...this.state.partial, [speaker]: on }
    if (speaker === 'you' && !on) this.lastYouEndAt = Date.now()
    this.changed()
  }

  private onSpeechStart(speaker: Speaker): void {
    if (this.state.session !== 'live') return
    this.setPartial(speaker, true)
    if (speaker === 'them') this.director.onThemStart()
  }

  private onSpeechEnd(speaker: Speaker, seg: Segment): void {
    this.setPartial(speaker, false)
    if (this.state.session !== 'live') return
    if (speaker === 'you') this.lastYouEndAt = Date.now()
    const id = newId('u')
    this.pending.set(id, { speaker, seg })
    const c = this.ch[speaker]
    c.queue.push({ id, seg })
    this.pumpStt(speaker)
    if (speaker === 'them') this.director.onThemEnd(seg.startedAt, seg.endedAt)
  }

  // ---------- transcription ----------

  private pumpStt(speaker: Speaker): void {
    const c = this.ch[speaker]
    while (c.inflight < STT_PARALLEL && c.queue.length) {
      const job = c.queue.shift()!
      c.inflight++
      const sessionId = this.state.sessionId
      const s = this.d.settings()
      transcribe(this.d.llm(), s.models.stt, job.seg.pcm, s.language)
        .then((text) => {
          if (this.state.sessionId !== sessionId) return
          this.pending.delete(job.id)
          if (text)
            this.addUtterance({
              id: job.id,
              speaker,
              text,
              startedAt: job.seg.startedAt,
              endedAt: job.seg.endedAt
            })
        })
        .catch((e) => {
          this.pending.delete(job.id)
          const msg = errorMessage(e)
          this.d.log(`stt error: ${msg}`)
          if (Date.now() - this.sttErrorAt > 10_000)
            this.d.toast('error', `Transcription failed: ${msg}`)
          this.sttErrorAt = Date.now()
        })
        .finally(() => {
          c.inflight--
          this.pumpStt(speaker)
        })
    }
  }

  private addUtterance(u: Utterance): void {
    const echoGuard = this.noAec
    if (echoGuard && u.speaker === 'you' && isEcho(u, this.state.utterances.slice(-10))) {
      this.d.log(`echo dropped: ${u.text}`)
      return
    }
    this.convo.add(u)
    if (echoGuard && u.speaker === 'them') {
      const echoes = this.state.utterances
        .slice(-10)
        .filter((x) => x.speaker === 'you' && isEcho(x, [u]))
      if (echoes.length) this.convo.remove(new Set(echoes.map((x) => x.id)))
    }
    this.d.onUtterance?.(u)
    if (u.speaker === 'you')
      this.deck.applyCoverage(this.state.utterances.filter((x) => x.speaker === 'you').slice(-20))
    const s = this.d.settings()
    this.convo
      .maybeFold(this.d.llm(), s.models.cue)
      .catch((e) => this.d.log(`summary error: ${errorMessage(e)}`))
    this.changed()
  }
}
