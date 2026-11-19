// npm run shots: builds the renderer (if stale), loads it with the demo bridge in plain Electron windows
// (not the app's main process) and saves PNGs of every screen and overlay state to shots/.
import { app, BrowserWindow } from 'electron'
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const outDir = join(root, 'out/shots-renderer')
const shotsDir = join(root, 'shots')

function newestMtime(dir) {
  return readdirSync(dir, { withFileTypes: true }).reduce((m, e) => {
    const p = join(dir, e.name)
    return Math.max(m, e.isDirectory() ? newestMtime(p) : statSync(p).mtimeMs)
  }, 0)
}

async function buildIfNeeded() {
  const index = join(outDir, 'index.html')
  const src = Math.max(
    newestMtime(join(root, 'src/renderer')),
    newestMtime(join(root, 'src/shared'))
  )
  if (existsSync(index) && statSync(index).mtimeMs > src) return
  console.log('building renderer…')
  const [{ build }, react, tailwind] = await Promise.all([
    import('vite'),
    import('@vitejs/plugin-react'),
    import('@tailwindcss/vite')
  ])
  await build({
    root: join(root, 'src/renderer'),
    base: './',
    logLevel: 'warn',
    resolve: { alias: { '@renderer': join(root, 'src/renderer/src') } },
    plugins: [react.default(), tailwind.default()],
    build: { outDir, emptyOutDir: true, chunkSizeWarningLimit: 4000 }
  })
}

const APP = [
  ['setup', 'demo=empty', '/setup'],
  ['home', 'demo=1&scene=none', '/home'],
  ['live', 'demo=1&scene=queued', '/live'],
  ['history', 'demo=1&scene=none', '/history'],
  ['session-recap', 'demo=1&scene=none', '/session/past-1'],
  ['settings', 'demo=1&scene=none', '/settings']
]
const OVERLAY = ['none', 'idle', 'streaming', 'followup', 'queued', 'error']

const jobs = []
for (const theme of ['light', 'dark'])
  for (const [name, q, hash] of APP)
    jobs.push({ file: `${name}-${theme}`, query: `${q}&theme=${theme}`, hash, w: 1100, h: 740 })
for (const scene of OVERLAY)
  for (const theme of ['light', 'dark'])
    jobs.push({
      file: `overlay-${scene}-${theme}`,
      query: `demo=1&scene=${scene}&theme=${theme}&backdrop=${theme}`,
      hash: '/overlay',
      w: 560,
      h: 340
    })
// Cross-checks: each theme over the opposite backdrop.
for (const [theme, backdrop] of [
  ['light', 'dark'],
  ['dark', 'light']
])
  jobs.push({
    file: `overlay-followup-${theme}-on-${backdrop}`,
    query: `demo=1&scene=followup&theme=${theme}&backdrop=${backdrop}`,
    hash: '/overlay',
    w: 560,
    h: 340
  })

let consoleProblems = 0

async function shoot(job) {
  const win = new BrowserWindow({
    width: job.w,
    height: job.h,
    show: false,
    frame: false,
    transparent: job.hash === '/overlay',
    webPreferences: { backgroundThrottling: false, contextIsolation: true, sandbox: true }
  })
  win.webContents.on('console-message', (e) => {
    const lvl = e.level
    const msg = e.message
    if (lvl === 'warning' || lvl === 'error') {
      consoleProblems++
      console.log(`  [${job.file}] console ${lvl}: ${msg}`)
    }
  })
  await win.loadFile(join(outDir, 'index.html'), { search: job.query, hash: job.hash })
  await new Promise((r) => setTimeout(r, 1400))
  const img = await win.webContents.capturePage()
  await writeFile(join(shotsDir, `${job.file}.png`), img.toPNG())
  console.log(`  shots/${job.file}.png  ${img.getSize().width}x${img.getSize().height}`)
  win.destroy()
}

// Windows are destroyed one by one; don't let Electron quit in between.
app.on('window-all-closed', () => {})

app.whenReady().then(async () => {
  try {
    await buildIfNeeded()
    mkdirSync(shotsDir, { recursive: true })
    for (const job of jobs) await shoot(job)
    console.log(`${jobs.length} screenshots, ${consoleProblems} console warnings/errors`)
    app.exit(consoleProblems ? 1 : 0)
  } catch (e) {
    console.error(e)
    app.exit(1)
  }
})
