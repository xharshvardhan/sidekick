// Brief files → model parts (pdf/images inline, text files as text). Node fs only, no Electron.
import { readFileSync } from 'fs'
import type { Part } from '@google/genai'
import type { BriefFile } from '../../shared/types'

const INLINE = /^(application\/pdf|image\/(png|jpeg|webp|heic|heif))$/
const TEXT = /^text\/|json|xml|yaml|csv|markdown/
const MAX_INLINE = 15 * 1024 * 1024
const MAX_TEXT_CHARS = 40_000

export function mimeFor(name: string): string {
  const ext = name.toLowerCase().split('.').pop() ?? ''
  const map: Record<string, string> = {
    pdf: 'application/pdf',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
    heic: 'image/heic',
    txt: 'text/plain',
    md: 'text/markdown',
    markdown: 'text/markdown',
    csv: 'text/csv',
    json: 'application/json',
    html: 'text/html',
    yaml: 'application/yaml',
    yml: 'application/yaml',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  }
  return map[ext] ?? 'application/octet-stream'
}

/** Returns the parts plus a list of files that could not be used (for a toast). */
export function briefParts(files: BriefFile[]): { parts: Part[]; skipped: string[] } {
  const parts: Part[] = []
  const skipped: string[] = []
  for (const f of files) {
    try {
      if (INLINE.test(f.mimeType) && f.bytes <= MAX_INLINE) {
        parts.push({ text: `BRIEF FILE: ${f.name}` })
        parts.push({
          inlineData: { mimeType: f.mimeType, data: readFileSync(f.path).toString('base64') }
        })
      } else if (TEXT.test(f.mimeType)) {
        parts.push({
          text: `BRIEF FILE: ${f.name}\n${readFileSync(f.path, 'utf8').slice(0, MAX_TEXT_CHARS)}`
        })
      } else skipped.push(`${f.name} (unsupported type; use PDF, image or text)`)
    } catch (e) {
      skipped.push(`${f.name} (${(e as Error).message})`)
    }
  }
  return { parts, skipped }
}
