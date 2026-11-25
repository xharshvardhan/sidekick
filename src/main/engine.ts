// The headless core: audio → segmenter → STT → conversation → director → cards, all in LiveState.
// No Electron imports: the app wraps it with windows/IPC, the sim drives it directly.
import { join } from 'path'
import type { Brief, LiveState, Session, Settings, Speaker, Utterance } from '../shared/types'
import { fakeCapture, spawnCapture, type Capture, type CaptureStatus } from './audio/capture'
import { Segmenter, type Segment } from './audio/segmenter'
import { isEcho, isEchoFrame } from './audio/echo'
import { pcmToWav, samplesToMs } from './audio/wav'
import { Conversation } from './convo'
import { Deck, newId, type UserActivity } from './director/cards'
import { Director, type RunRecord } from './director/director'
import { briefParts } from './director/brief'
import type { PendingAudio } from './director/prompt'
import { errorMessage, type Llm } from './llm'
import { callLanguage, transcribe } from './stt'

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
  /** macOS permission state (mic: Microphone, system: Screen Recording). A denied mic delivers zeros,
   *  which must not look like a wedged AEC unit; a denied channel restarts once this turns true. */
  granted?(key: AudioKey): boolean
}

type AudioKey = 'mic' | 'system'

interface Channel {
  seg: Segmenter
  cap: Capture | null
  inflight: number
  queue: { id: string; seg: Segment; sessionId: string | null }[]
  error: string // shown in the UI; empty when healthy
  deniedAt: number // last time the helper reported a missing permission; 0 once it works again
  grantedWhenDenied: boolean // macOS already said "granted" when the helper was denied
}

const STT_PARALLEL = 3
const LOUD_RMS = 300 // "the system channel has audio"
const ZERO_FALLBACK_MS = 3000
const PERMISSION_RECHECK_MS = 3000
const MAX_PENDING_AUDIO_MS = 60_000 // untranscribed speech attached to a cue
const DENIED_MESSAGE: Record<AudioKey, string> = {
  mic: "Sidekick can't hear you yet. Allow Microphone in Setup.",
  system: "Sidekick can't hear the other side yet. Allow Screen & System Audio Recording in Setup."
}

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
  private youStartAt = 0
  private testing = false
  private audioOn = false
  private noAecFallback = false
  private ending = false
  private endedAt = 0
  private micZeroMs = 0
  private sysLoudAt = 0
  private timers: NodeJS.Timeout[] = []
  private levelsTimer: NodeJS.Timeout | null = null
  private permTimer: NodeJS.Timeout | null = null
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
    this.ch.you.queue = []
    this.ch.them.queue = []
    this.lastYouEndAt = 0
    this.youStartAt = 0
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

  /** Ends the session. Speech still in progress is closed and sent for transcription; see `settled`. */
  end(): void {
    if (this.state.session === 'idle' || this.state.session === 'ended') return
    if (this.state.session === 'live') {
      this.director.cancelAll()
      this.ending = true // flushed `them` speech is transcribed but does not trigger a cue
      this.ch.you.seg.flush()
      this.ch.them.seg.flush()
      this.ending = false
    }
    this.stopSessionWork()
    this.state.session = 'ended'
    this.endedAt = Date.now()
    this.changed()
  }

  /** Resolves once every transcript of the session has landed, or after `maxMs`. */
  async settled(maxMs = 5000): Promise<void> {
    const until = Date.now() + maxMs
    while (this.pending.size && Date.now() < until) await new Promise((r) => setTimeout(r, 100))
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
      endedAt: st.session === 'ended' ? this.endedAt : undefined,
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
      this.restartChannel('you')
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
      lastYouSpeechAt: this.lastYouEndAt,
      youSpeechStartedAt: this.youStartAt
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
        ...this.pendingAudio()
      }),
      activity: () => this.activity(),
      changed: () => this.changed(),
      toast: this.d.toast,
      onRun: this.d.onRun
    })
  }

  /** All untranscribed speech, oldest first, capped to the newest 60 s; the rest is reported as omitted. */
  private pendingAudio(): { audio: PendingAudio[]; audioOmittedMs: number } {
    const all = [...this.pending.values()].sort((a, b) => a.seg.startedAt - b.seg.startedAt)
    const audio: PendingAudio[] = []
    let total = 0
    let omitted = 0
    for (let i = all.length - 1; i >= 0; i--) {
      const len = samplesToMs(all[i].seg.pcm.length)
      if (total + len > MAX_PENDING_AUDIO_MS) omitted += len
      else {
        total += len
        audio.unshift({ speaker: all[i].speaker, wav: pcmToWav(all[i].seg.pcm) })
      }
    }
    return { audio, audioOmittedMs: omitted }
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
      // energy gate: mic "speech" that is really the speakers' echo (residual echo with AEC on)
      suppress:
        speaker === 'you'
          ? (r) => isEchoFrame(r, this.ch.them.seg.recentPeak(), !this.noAec)
          : undefined
    })
    return {
      seg,
      cap: null,
      inflight: 0,
      queue: [],
      error: '',
      deniedAt: 0,
      grantedWhenDenied: false
    }
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
    if (!this.d.fakeDir && this.d.granted)
      this.permTimer = setInterval(() => this.recheckDenied(), PERMISSION_RECHECK_MS)
  }

  /** A denied channel stays stopped; start it again once macOS reports the permission granted. */
  private recheckDenied(): void {
    for (const sp of ['you', 'them'] as Speaker[]) {
      const key = sp === 'you' ? 'mic' : 'system'
      if (this.state.audio[key] !== 'denied') continue
      const c = this.ch[sp]
      const granted = this.d.granted!(key)
      // restart when it flips to granted; if macOS said granted all along, retry only every 30 s
      if (granted && (!c.grantedWhenDenied || Date.now() - c.deniedAt > 30_000)) {
        this.d.log(`audio ${key}: permission granted, starting capture`)
        this.restartChannel(sp)
      } else c.grantedWhenDenied = granted
    }
  }

  private stopAudio(): void {
    if (!this.audioOn) return
    this.audioOn = false
    for (const sp of ['you', 'them'] as Speaker[]) {
      this.ch[sp].cap?.stop()
      this.ch[sp].cap = null
      this.ch[sp].seg.anchor(0)
      this.ch[sp].error = ''
      this.ch[sp].deniedAt = 0
    }
    if (this.levelsTimer) clearInterval(this.levelsTimer)
    if (this.permTimer) clearInterval(this.permTimer)
    this.levelsTimer = this.permTimer = null
    this.fakeStart = null
    this.state.audio = { ...this.state.audio, mic: 'off', system: 'off' }
    this.updateAudioMessage()
    this.d.emitLevels({ you: 0, them: 0 })
    this.changed()
  }

  private restartChannel(speaker: Speaker): void {
    this.ch[speaker].cap?.stop()
    this.ch[speaker].seg.anchor(0)
    this.setPartial(speaker, false)
    this.startChannel(speaker)
  }

  private startChannel(speaker: Speaker): void {
    const c = this.ch[speaker]
    const key = speaker === 'you' ? 'mic' : 'system'
    const handlers = {
      onReady: (at: number) => {
        c.seg.anchor(at) // drops any open segment, so the speaking flag goes too
        this.setPartial(speaker, false)
      },
      onData: (pcm: Int16Array) => this.onData(speaker, pcm),
      onStatus: (status: CaptureStatus, message?: string) => {
        const was = this.state.audio[key]
        if (
          speaker === 'you' &&
          status === 'ok' &&
          !this.d.fakeDir &&
          this.d.granted?.('mic') === false
        )
          status = 'denied'
        this.state.audio[key] = status
        c.error =
          status === 'denied'
            ? DENIED_MESSAGE[key]
            : status === 'error'
              ? `${speaker === 'you' ? 'Mic' : 'Call audio'}: ${message}`
              : ''
        // one toast per denial, not one per retry
        const tell = status === 'error' ? was !== status : status === 'denied' && !c.deniedAt
        if (status === 'ok') c.deniedAt = 0
        if (status === 'denied' && was !== 'denied') {
          c.deniedAt = Date.now()
          c.grantedWhenDenied = this.d.granted?.(key) ?? false
        }
        this.updateAudioMessage()
        if (tell) {
          this.d.toast('error', c.error)
          this.d.log(`audio ${key} ${status}: ${message ?? ''}`)
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
      this.ch.you.error,
      this.ch.them.error
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
    if (this.d.fakeDir || this.noAec || this.d.granted?.('mic') === false) return
    if (pcm.every((v) => v === 0)) this.micZeroMs += samplesToMs(pcm.length)
    else this.micZeroMs = 0
    if (this.micZeroMs >= ZERO_FALLBACK_MS && Date.now() - this.sysLoudAt < ZERO_FALLBACK_MS) {
      this.micZeroMs = 0
      this.noAecFallback = true
      this.d.log('mic silent with AEC while call audio plays: restarting mic without AEC')
      this.updateAudioMessage()
      this.restartChannel('you')
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
    if (speaker === 'you') this.youStartAt = Date.now()
    if (speaker === 'them') this.director.onThemStart()
  }

  private onSpeechEnd(speaker: Speaker, seg: Segment): void {
    this.setPartial(speaker, false)
    if (this.state.session !== 'live') return
    if (speaker === 'you') this.lastYouEndAt = Date.now()
    const id = newId('u')
    this.pending.set(id, { speaker, seg })
    const c = this.ch[speaker]
    c.queue.push({ id, seg, sessionId: this.state.sessionId })
    this.pumpStt(speaker)
    if (speaker === 'them' && !this.ending) this.director.onThemEnd(seg.startedAt, seg.endedAt)
  }

  // ---------- transcription ----------

  private pumpStt(speaker: Speaker): void {
    const c = this.ch[speaker]
    while (c.inflight < STT_PARALLEL && c.queue.length) {
      const job = c.queue.shift()!
      const { sessionId } = job
      if (sessionId !== this.state.sessionId) continue // queued in an earlier session
      c.inflight++
      const s = this.d.settings()
      const lang = s.language || callLanguage(this.state.utterances.slice(-6).map((u) => u.text))
      transcribe(this.d.llm(), s.models.stt, job.seg.pcm, lang)
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
    // runs with AEC on too: residual echo can still slip through; it needs time overlap and ≥ 60% shared words
    if (u.speaker === 'you' && isEcho(u, this.state.utterances.slice(-10))) {
      this.d.log(`echo dropped: ${u.text}`)
      return
    }
    this.convo.add(u)
    if (u.speaker === 'them') {
      const echoes = this.state.utterances
        .slice(-10)
        .filter((x) => x.speaker === 'you' && isEcho(x, [u]))
      for (const x of echoes) this.d.log(`echo removed: ${x.text}`)
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
