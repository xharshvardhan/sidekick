import { chmodSync, mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { spawnCapture, type CaptureStatus } from '../src/main/audio/capture'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function helper(script: string): string {
  const file = join(mkdtempSync(join(tmpdir(), 'sk-cap-')), 'audiocap')
  writeFileSync(file, `#!/bin/sh\n${script}\n`)
  chmodSync(file, 0o755)
  return file
}

function watch(bin: string): { statuses: CaptureStatus[]; stop: () => void } {
  const statuses: CaptureStatus[] = []
  const cap = spawnCapture(bin, [], {
    onReady: () => {},
    onData: () => {},
    onStatus: (s) => statuses.push(s)
  })
  return { statuses, stop: () => cap.stop() }
}

describe('spawnCapture', () => {
  it('a missing permission stops the restart loop', async () => {
    const w = watch(helper('echo "error: no display" >&2; exit 1'))
    await sleep(1600) // past the first 1 s backoff
    w.stop()
    expect(w.statuses.filter((s) => s === 'starting')).toHaveLength(1)
    expect(w.statuses.at(-1)).toBe('denied')
  })

  it('a helper that cannot be spawned is retried', async () => {
    const w = watch('/nonexistent/audiocap')
    await sleep(1500)
    w.stop()
    expect(w.statuses.filter((s) => s === 'starting').length).toBeGreaterThanOrEqual(2)
    expect(w.statuses).toContain('error')
  })
})
