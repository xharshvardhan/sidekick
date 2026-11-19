// Realistic seeded data for the demo bridge (?demo=1). Nothing here ships to the engine.
import type {
  Card,
  CardSection,
  Hotkey,
  LiveState,
  Permissions,
  Recap,
  Session,
  Settings,
  Utterance
} from '../../../shared/types'

const MIN = 60_000
export const now = Date.now()
export const liveStart = now - 14 * MIN - 22_000

const script: [Utterance['speaker'], string][] = [
  ['them', 'Hi Priya, thanks for joining. Can you hear me okay?'],
  ['you', 'Yes, loud and clear. Thanks for having me.'],
  ['them', "Great. Let's start simple: tell me a bit about yourself."],
  [
    'you',
    "Sure. I'm a backend engineer, six years in, the last three at Ledgerly working on payments infrastructure."
  ],
  ['you', 'Most recently I led the move of our settlement pipeline to an event-driven design.'],
  ['them', 'Nice. What did that change for the business?'],
  [
    'you',
    'Settlement went from a nightly batch to under two minutes, and failed payouts dropped by about forty percent.'
  ],
  [
    'them',
    "Okay, let's get into some design. How would you design a rate limiter for our public API?"
  ],
  [
    'you',
    "I'd start with a token bucket per API key, kept in Redis so every gateway node sees the same count."
  ],
  ['you', "Refill rate and burst size come from the customer's plan."],
  ['them', 'And how would that work across regions? We run in three.'],
  [
    'you',
    "I wouldn't want a cross-region round trip on every request, so each region keeps its own bucket."
  ],
  ['you', 'Then we sync usage asynchronously and accept a small overshoot.'],
  ['them', "Makes sense. Let's switch gears: tell me about a time you disagreed with your manager."]
]

export const utterances: Utterance[] = script.map(([speaker, text], i) => {
  const startedAt = liveStart + 20_000 + i * 58_000
  return { id: `u${i}`, speaker, text, startedAt, endedAt: startedAt + 4_000 + text.length * 40 }
})

let pid = 0
const pts = (items: [string, boolean][]): CardSection['points'] =>
  items.map(([text, covered]) => ({ id: `p${pid++}`, text, covered }))

export const cardAbout: Card = {
  id: 'c1',
  createdAt: liveStart + 2 * MIN,
  source: 'auto',
  status: 'done',
  sections: [
    {
      id: 's1',
      prompt: 'Tell me about yourself',
      say: "I'm a backend engineer with six years in payments, most recently leading Ledgerly's move to event-driven settlement.",
      points: pts([
        ['Six years backend, three at Ledgerly', true],
        ['Led the settlement pipeline redesign', true],
        ['Nightly batch to under two minutes', true],
        ['Why Northwind: an API platform at scale', false]
      ]),
      detail: ''
    }
  ]
}

export const sectionLimiter: CardSection = {
  id: 's2',
  prompt: 'Design a rate limiter for the public API',
  say: "I'd use a token bucket per API key in Redis, with refill and burst set by the customer's plan.",
  points: pts([
    ['Token bucket per API key', true],
    ['Shared state in Redis, atomic Lua script', true],
    ['Refill and burst from the plan tier', true],
    ['Return 429 with a Retry-After header', false]
  ]),
  detail: [
    'Atomic check-and-take in one round trip:',
    '',
    '```lua',
    "local tokens = tonumber(redis.call('GET', KEYS[1]) or ARGV[1])",
    'if tokens < 1 then return 0 end',
    "redis.call('DECR', KEYS[1])",
    'return 1',
    '```',
    '',
    'Plan tiers: **Free** 10 req/s, **Pro** 100 req/s, burst 2x the rate.'
  ].join('\n')
}

export const sectionRegions: CardSection = {
  id: 's3',
  prompt: 'How it works across three regions',
  say: "I'd keep a bucket in each region and sync usage in the background, trading a small overshoot for no cross-region hop.",
  points: pts([
    ['Local bucket per region, no cross-region hop', true],
    ['Async usage sync every 1 to 2 seconds', true],
    ['Overshoot bounded to about 3% of the limit', false],
    ['Strict global limit only for top-tier keys', false]
  ]),
  detail: [
    'Worst-case overshoot = regions x rate x sync interval.',
    '',
    'At 100 req/s, 3 regions and a 1 s sync that is **at most 300 extra requests**, acceptable for a public API.',
    '',
    '```ts',
    'const overshoot = regions * ratePerSec * syncSeconds // 3 * 100 * 1 = 300',
    '```'
  ].join('\n')
}

export const cardLimiter: Card = {
  id: 'c2',
  createdAt: liveStart + 7 * MIN,
  source: 'auto',
  status: 'done',
  sections: [sectionLimiter, sectionRegions]
}

/** Mid-stream: say done, two points in, prompt not arrived yet. */
export const cardConflict: Card = {
  id: 'c3',
  createdAt: now - 4_000,
  source: 'auto',
  status: 'streaming',
  sections: [
    {
      id: 's4',
      prompt: '',
      say: 'At Ledgerly I pushed back on launching payouts without idempotency keys, and we agreed to a one-week delay.',
      points: pts([
        ['Situation: launch date vs. duplicate payout risk', false],
        ['Brought data: 0.4% of payouts retried in staging', false]
      ]),
      detail: ''
    }
  ]
}

export const cardLeaving: Card = {
  id: 'c4',
  createdAt: now - 1_000,
  source: 'auto',
  status: 'done',
  sections: [
    {
      id: 's5',
      prompt: 'Why are you leaving Ledgerly?',
      say: "I've done the zero-to-one work on payments; now I want to build an API platform thousands of developers rely on.",
      points: pts([
        ['Proud of Ledgerly, not running away', false],
        ['Want platform scale and developer users', false],
        ['Northwind API is the product, not a side feature', false]
      ]),
      detail: ''
    }
  ]
}

export const cardError: Card = {
  id: 'c5',
  createdAt: now - 3_000,
  source: 'ask',
  status: 'error',
  sections: [],
  error: "The answer model didn't respond within 10 seconds. Press ⌥⇧A to try again."
}

export const hotkeys: Hotkey[] = [
  { id: 'ask', label: 'Help me now', accelerator: 'Alt+Shift+A' },
  { id: 'screen', label: 'Solve what is on screen', accelerator: 'Alt+Shift+S' },
  { id: 'deeper', label: 'Go deeper on this card', accelerator: 'Alt+Shift+D' },
  { id: 'prevCard', label: 'Previous card', accelerator: 'Alt+Shift+[' },
  { id: 'nextCard', label: 'Next card', accelerator: 'Alt+Shift+]' },
  { id: 'pin', label: 'Pin card', accelerator: 'Alt+Shift+P' },
  { id: 'toggleOverlay', label: 'Show or hide overlay', accelerator: 'Alt+Shift+H' },
  { id: 'toggleMode', label: 'Switch app / overlay only', accelerator: 'Alt+Shift+M' },
  { id: 'toggleListening', label: 'Pause or resume listening', accelerator: 'Alt+Shift+L' }
]

export function seedSettings(fresh: boolean): Settings {
  return {
    vertex: {
      project: fresh ? '' : 'sidekick-dev-4821',
      location: 'global',
      credentialsPath: fresh ? '' : '/Users/priya/.config/gcloud/sidekick-sa.json'
    },
    models: { stt: 'gemini-3.5-flash-lite', cue: 'gemini-3.5-flash', deep: 'gemini-4-hydrogen' },
    profile: fresh
      ? ''
      : 'Priya Raman. Senior backend engineer, 6 years. Ledgerly (payments infra, 3 yrs): led event-driven settlement rewrite, nightly batch to < 2 min, failed payouts down 40%. Before: Shopwise (search APIs). Go, TypeScript, Postgres, Redis, Kafka. Prefer concise, concrete answers with numbers.',
    autoCue: true,
    answerStyle: 'brief',
    language: '',
    echoCancellation: true,
    overlay: {
      showOnStart: true,
      hideFromScreenShare: false,
      opacity: 1,
      fontScale: 1,
      bounds: null
    },
    theme: 'system',
    hotkeys,
    onboarded: !fresh
  }
}

export function seedPermissions(fresh: boolean): Permissions {
  return fresh
    ? {
        microphone: 'granted',
        screen: 'denied',
        vertex: { ok: false, message: 'No Vertex project set. Add it in Settings → Vertex.' }
      }
    : {
        microphone: 'granted',
        screen: 'granted',
        vertex: { ok: true, message: 'Connected to sidekick-dev-4821 (global), 412 ms' }
      }
}

export function seedLive(scene: string, fresh: boolean): LiveState {
  const base: LiveState = {
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
    autoCue: true,
    thinking: false,
    audio: { mic: 'off', system: 'off', echoCancellation: true }
  }
  if (fresh || scene === 'none') return base
  const live: LiveState = {
    ...base,
    session: 'live',
    sessionId: 'live-1',
    title: 'Northwind · Senior Backend Engineer',
    startedAt: liveStart,
    utterances,
    audio: { mic: 'ok', system: 'ok', echoCancellation: true },
    cards: [cardAbout, cardLimiter, cardConflict]
  }
  switch (scene) {
    case 'idle':
      return {
        ...live,
        utterances: utterances.slice(0, 3),
        cards: [],
        partial: { you: false, them: true }
      }
    case 'streaming':
      return { ...live, activeCardId: 'c3', thinking: true }
    case 'followup':
      return { ...live, cards: [cardAbout, cardLimiter], activeCardId: 'c2' }
    case 'error':
      return {
        ...live,
        cards: [cardAbout, cardLimiter, cardError],
        activeCardId: 'c5',
        audio: {
          mic: 'ok',
          system: 'error',
          echoCancellation: true,
          message: 'Call audio stopped. Reconnecting…'
        }
      }
    default: // 'queued' and the animated default
      return {
        ...live,
        cards: [cardAbout, cardLimiter, cardConflict, cardLeaving],
        activeCardId: 'c2',
        queuedCardId: 'c4',
        partial: { you: true, them: false }
      }
  }
}

const recap: Recap = {
  summary: [
    'A 48-minute **staff engineer screen** with Marcus (Eng Director). Strong on system design and the migration story; the leadership question ran long.',
    '',
    '- Marcus confirmed the team owns the fleet telemetry pipeline (about 2 TB/day).',
    '- Next round is a half-day onsite: architecture, coding, and a values interview.',
    '- Comp band was not discussed; recruiter will follow up.'
  ].join('\n'),
  actionItems: [
    'Send Marcus the write-up on the Kafka to Pulsar migration by Friday',
    'Ask the recruiter for the onsite schedule and the comp band',
    'Prepare a tighter 2-minute answer for "a time you led without authority"'
  ],
  questions: [
    {
      asked: 'Walk me through the telemetry migration you led.',
      howItWent: 'Clear and numbers-driven; covered all four card points.'
    },
    {
      asked: 'How would you shard a time-series store for 50k robots?',
      howItWent: 'Good partitioning answer; missed the retention trade-off until prompted.'
    },
    {
      asked: 'Tell me about leading without authority.',
      howItWent: 'Ran about 4 minutes. Lead with the outcome next time.'
    }
  ]
}

const DAY = 24 * 60 * MIN
const past: [string, Session['preset'], number, number, number, number][] = [
  ['Acme Robotics · Staff Engineer screen', 'interview', 2 * DAY + 3 * 60 * MIN, 48, 112, 9],
  ['Weekly sync with Dana', 'meeting', 3 * DAY, 31, 74, 3],
  ['Helix Health · discovery call', 'sales', 5 * DAY + 5 * 60 * MIN, 42, 96, 7],
  ['Brightwave · System design round', 'interview', 8 * DAY, 61, 140, 12],
  ['Contractor rate negotiation', 'custom', 12 * DAY, 18, 33, 2]
]

export function seedSessions(): Session[] {
  return past.map(([title, preset, ago, mins, utteranceCount, cardCount], i) => ({
    id: `past-${i + 1}`,
    title,
    preset,
    startedAt: now - ago,
    endedAt: now - ago + mins * MIN,
    utteranceCount,
    cardCount,
    brief: { title, preset, notes: '', files: [] },
    utterances: utterances
      .slice(0, 10)
      .map((u) => ({ ...u, startedAt: u.startedAt - ago, endedAt: u.endedAt - ago })),
    cards: [cardAbout, cardLimiter],
    summary: '',
    recap: i === 0 ? recap : undefined
  }))
}

export const demoRecap = recap
