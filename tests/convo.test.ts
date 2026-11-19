import { describe, expect, it } from 'vitest'
import { Conversation } from '../src/main/convo'
import type { Llm } from '../src/main/llm'
import type { Utterance } from '../src/shared/types'

const u = (i: number): Utterance => ({
  id: `u${i}`,
  speaker: i % 2 ? 'you' : 'them',
  text: `line ${i}`,
  startedAt: i * 1000,
  endedAt: i * 1000 + 500
})

describe('Conversation fold', () => {
  it('a transcript that lands inside the range being summarized is folded next time, not lost', async () => {
    const c = new Conversation([])
    for (let i = 0; i < 46; i++) c.add(u(i * 2)) // even seconds, leaves gaps
    const prompts: string[] = []
    let release!: (t: string) => void
    const llm = {
      models: {
        generateContent: (req: { contents: { parts: { text: string }[] }[] }) => {
          prompts.push(req.contents[0].parts[0].text)
          return new Promise((r) => (release = (text) => r({ text })))
        }
      }
    } as unknown as Llm
    const first = c.maybeFold(llm, 'm', Date.now())
    c.add(u(5)) // started at 5 s, inside the chunk being summarized
    release('summary one')
    await first
    expect(prompts[0]).not.toContain('line 5\n')
    const second = c.maybeFold(llm, 'm', Date.now() + 4 * 60_000)
    release('summary two')
    await second
    expect(prompts[1]).toContain('line 5\n')
  })
})
