// Vertex Gemini client and small call helpers. No Electron imports.
import {
  GoogleGenAI,
  ThinkingLevel,
  type GenerateContentConfig,
  type Part,
  type ThinkingConfig
} from '@google/genai'
import type { Settings } from '../shared/types'

export type Llm = GoogleGenAI

/** Create a client. Credentials go through the env var, which must be set before the client exists. */
export function makeLlm(v: Settings['vertex']): Llm {
  if (v.credentialsPath) process.env.GOOGLE_APPLICATION_CREDENTIALS = v.credentialsPath
  return new GoogleGenAI({ vertexai: true, project: v.project, location: v.location || 'global' })
}

/** gemini-4-* reject thinkingBudget; gemini-3.5-* accept it. Both get the cheapest setting. */
export function thinkingFor(model: string): ThinkingConfig {
  return /^gemini-4/.test(model) ? { thinkingLevel: ThinkingLevel.LOW } : { thinkingBudget: 0 }
}

export interface CallOpts {
  model: string
  system?: string
  parts: Part[]
  signal?: AbortSignal
  json?: boolean
  maxTokens?: number
}

const config = (o: CallOpts): GenerateContentConfig => ({
  systemInstruction: o.system,
  thinkingConfig: thinkingFor(o.model),
  abortSignal: o.signal,
  maxOutputTokens: o.maxTokens,
  ...(o.json ? { responseMimeType: 'application/json' } : {})
})

/** Stream text; calls onText with the full text so far. Resolves with the final text. */
export async function streamText(
  ai: Llm,
  o: CallOpts,
  onText: (full: string) => void
): Promise<string> {
  const stream = await ai.models.generateContentStream({
    model: o.model,
    contents: [{ role: 'user', parts: o.parts }],
    config: config(o)
  })
  let full = ''
  for await (const chunk of stream) {
    if (o.signal?.aborted) throw new DOMException('aborted', 'AbortError')
    const t = chunk.text
    if (t) {
      full += t
      onText(full)
    }
  }
  return full
}

export async function generateText(ai: Llm, o: CallOpts): Promise<string> {
  const r = await ai.models.generateContent({
    model: o.model,
    contents: [{ role: 'user', parts: o.parts }],
    config: config(o)
  })
  return r.text ?? ''
}

export const isAbort = (e: unknown): boolean =>
  (e as Error)?.name === 'AbortError' || /abort/i.test((e as Error)?.message ?? '')

/** A short human-readable message for a Vertex failure. */
export function errorMessage(e: unknown): string {
  const m = String((e as Error)?.message ?? e)
  if (/Could not load the default credentials|ENOENT.*json|credential/i.test(m))
    return 'Vertex credentials not found. Set the key path in Settings → Vertex.'
  if (/PERMISSION_DENIED|403/.test(m))
    return 'Vertex refused the request (permission denied). Check the project and key.'
  if (/NOT_FOUND|404/.test(m))
    return 'Vertex model or project not found. Check Settings → Models / Vertex.'
  if (/RESOURCE_EXHAUSTED|429/.test(m)) return 'Vertex rate limit hit. Try again in a moment.'
  if (/ENOTFOUND|ECONNRESET|ETIMEDOUT|fetch failed|network/i.test(m))
    return 'Network problem reaching Vertex.'
  const short = m.replace(/\s+/g, ' ').slice(0, 160)
  return `Vertex error: ${short}`
}

export const audioPart = (wav: Buffer): Part => ({
  inlineData: { mimeType: 'audio/wav', data: wav.toString('base64') }
})
