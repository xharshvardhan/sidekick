// PCM16 mono 16 kHz helpers. Pure, no Electron.

export const SAMPLE_RATE = 16000
export const samplesToMs = (n: number): number => (n * 1000) / SAMPLE_RATE

/** Wrap raw PCM16 mono samples in a 44-byte WAV header. */
export function pcmToWav(pcm: Int16Array): Buffer {
  const data = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength)
  const h = Buffer.alloc(44)
  h.write('RIFF', 0)
  h.writeUInt32LE(36 + data.length, 4)
  h.write('WAVE', 8)
  h.write('fmt ', 12)
  h.writeUInt32LE(16, 16)
  h.writeUInt16LE(1, 20) // PCM
  h.writeUInt16LE(1, 22) // mono
  h.writeUInt32LE(SAMPLE_RATE, 24)
  h.writeUInt32LE(SAMPLE_RATE * 2, 28)
  h.writeUInt16LE(2, 32)
  h.writeUInt16LE(16, 34)
  h.write('data', 36)
  h.writeUInt32LE(data.length, 40)
  return Buffer.concat([h, data])
}

/** Extract the samples of a PCM16 WAV by walking its chunks to `data`. */
export function wavToPcm(buf: Buffer): Int16Array {
  let off = 12
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4)
    const size = buf.readUInt32LE(off + 4)
    if (id === 'data') {
      const end = Math.min(buf.length, off + 8 + size)
      const bytes = buf.subarray(off + 8, end - ((end - off - 8) % 2))
      return new Int16Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length))
    }
    off += 8 + size + (size % 2)
  }
  throw new Error('no data chunk in WAV')
}

export function rms(s: Int16Array, from = 0, to = s.length): number {
  if (to <= from) return 0
  let sum = 0
  for (let i = from; i < to; i++) sum += s[i] * s[i]
  return Math.sqrt(sum / (to - from))
}

export function concatPcm(parts: Int16Array[]): Int16Array {
  const out = new Int16Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

/** rms → 0..1 meter value on a log scale (≈ -60 dBFS → 0, -6 dBFS → 1). */
export function rmsToLevel(r: number): number {
  if (r <= 1) return 0
  const db = 20 * Math.log10(r / 32768)
  return Math.max(0, Math.min(1, (db + 60) / 54))
}
