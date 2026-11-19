// Load `.env.local` (dev and sim only) into process.env without overriding what is already set.
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

export function loadEnvLocal(root: string): void {
  const file = join(root, '.env.local')
  if (!existsSync(file)) return
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line)
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
}
