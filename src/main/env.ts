// `.env.local` reading (dev, sim, and the packaged app's first-run Vertex seed). Values only; never logged.
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

export function readEnvFile(file: string): Record<string, string> {
  const out: Record<string, string> = {}
  if (!existsSync(file)) return out
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line)
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
  return out
}

/** Load `<root>/.env.local` into process.env without overriding what is already set. */
export function loadEnvLocal(root: string): void {
  for (const [k, v] of Object.entries(readEnvFile(join(root, '.env.local'))))
    if (!(k in process.env)) process.env[k] = v
}
