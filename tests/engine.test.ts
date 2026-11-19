import { describe, expect, it } from 'vitest'
import { Engine } from '../src/main/engine'
import type { Segment } from '../src/main/audio/segmenter'
import type { Llm } from '../src/main/llm'
import { defaultSettings } from '../src/main/settings'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const brief = { title: 't', preset: 'meeting' as const, notes: '', files: [] }

describe('Engine session boundaries', () => {
  it('transcripts from an ended session never land in the next one', async () => {
    const waiting: (() => void)[] = []
    const llm = {
      models: {
        // STT: hold every request until released
        generateContent: () => new Promise((r) => waiting.push(() => r({ text: 'old words' })))
      }
    } as unknown as Llm
    const settings = { ...defaultSettings(), autoCue: false }
    const engine = new Engine({
      llm: () => llm,
      settings: () => settings,
      bin: '',
      fakeDir: '/nonexistent', // no audio; segments are injected below
      emitLive: () => {},
      emitLevels: () => {},
      toast: () => {},
      log: () => {}
    })
    engine.start(brief)
    const speechEnd = (engine as unknown as { onSpeechEnd(s: string, seg: Segment): void })
      .onSpeechEnd
    const seg: Segment = { pcm: new Int16Array(16000), startedAt: 1, endedAt: 2, speechMs: 900 }
    for (let i = 0; i < 5; i++) speechEnd.call(engine, 'them', seg) // 3 in flight, 2 queued
    engine.end()
    engine.start(brief)
    while (waiting.length) {
      waiting.shift()!()
      await sleep(5)
    }
    await sleep(50)
    expect(engine.state.utterances).toHaveLength(0)
    engine.end()
  })
})
