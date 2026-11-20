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

/** Stress case: seven follow-ups, a very long prompt, a long code line. */
const follow = (n: number, prompt: string, say: string, detail = ''): CardSection => ({
  id: `m${n}`,
  prompt,
  say,
  points: pts([
    ['First thing worth saying about this', n % 2 === 0],
    ['Second point, with a number: 99.9% availability', false]
  ]),
  detail
})
export const cardSeven: Card = {
  id: 'c6',
  createdAt: now - 2_000,
  source: 'auto',
  status: 'done',
  sections: [
    follow(
      1,
      'Design a URL shortener',
      'I would generate a base62 id from a counter and store the mapping in a key-value store.'
    ),
    follow(
      2,
      'How would you avoid collisions between several writers at once',
      'Each writer takes a block of ids from a central counter, so no two writers can ever hand out the same id.'
    ),
    follow(
      3,
      'What about custom aliases that users pick themselves',
      'Aliases go in the same table with a unique constraint; a clash returns a clear error to the user.'
    ),
    follow(
      4,
      'How do you keep reads fast when one link goes viral',
      'Cache hot links at the edge and in Redis; the database only sees cache misses.'
    ),
    follow(
      5,
      'How would you expire links after a set time',
      'Store an expiry with each row; reads check it, and a nightly job deletes the old rows.'
    ),
    follow(
      6,
      'And analytics: count clicks per link without slowing redirects',
      'Publish a click event to a queue after the redirect and aggregate it in batches.'
    ),
    follow(
      7,
      'Show me the schema and the id generator in code, including the block allocation that each writer does on start up',
      'The table is three columns, and each writer holds a block of 1,000 ids in memory.',
      [
        'Block allocation, one round trip per 1,000 ids:',
        '',
        '```sql',
        'UPDATE id_counter SET next_id = next_id + 1000 WHERE name = $1 RETURNING next_id - 1000 AS block_start, next_id AS block_end, now() AS allocated_at, current_setting($2) AS node_label;',
        '```',
        '',
        '```ts',
        "const encode = (n: number): string => n.toString(36).padStart(7, '0') + '-' + Math.random().toString(36).slice(2) + '-and-a-very-long-suffix-to-force-overflow'",
        '```',
        '',
        '| table | columns |',
        '| --- | --- |',
        '| links | id, target_url, expires_at |'
      ].join('\n')
    )
  ]
}

/** A real deep pass (gemini-4-hydrogen via `npm run deep`), under the cue model's instant card. */
export const cardDecoder: Card = {
  id: 'c7',
  createdAt: now - 20_000,
  source: 'auto',
  status: 'done',
  sections: [
    {
      id: 's7',
      prompt: 'Explain and draw the transformer decoder',
      say: 'The decoder is an autoregressive stack that predicts the next token by looking at previous tokens and encoder outputs.',
      points: pts([
        ['Masked self-attention prevents looking at future tokens', false],
        ['Cross-attention keys and values come from the encoder', false],
        ['Feed-forward network processes each position independently', false]
      ]),
      detail: "```text\nTarget tokens [B, T]\n  |\n  v\n[ Token Emb + Pos Enc ] -> X: [B, T, d]\n  |\n  v\n+----------------------------------------+\n| N x Decoder Layer                      |\n|                                        |\n|  Q, K, V = X                           |\n|  [ Masked Multi-Head Self-Attn ]       |\n|  (causal mask M: -inf for j > i)       |\n|    |                                   |\n|    v                                   |\n|  [ Add & LayerNorm ] -> X1: [B, T, d]  |\n|    |                                   |\n|    v                                   |\n|  Q = X1; K, V = enc_out [B, S, d]      |\n|  [ Cross-Attention ]                   |\n|    |                                   |\n|    v                                   |\n|  [ Add & LayerNorm ] -> X2: [B, T, d]  |\n|    |                                   |\n|    v                                   |\n|  [ Feed-Forward (FFN) ]                |\n|    |                                   |\n|    v                                   |\n|  [ Add & LayerNorm ] -> X: [B, T, d]   |\n+----------------------------------------+\n  |\n  v\n[ Linear (d -> V) + Softmax ]\n  |\n  v\nNext-token probs [B, T, V]\n```\n\n- Attention formula: `softmax((Q * K^T) / sqrt(d_k) + M) * V`, where `d_k = d / h` keeps dot-product variance from saturating softmax.\n- Causal mask `M` adds `-inf` to future positions (`j > i`) before softmax so their attention weights become `0`.\n- Cross-attention uses the decoder's `X1` as `Q` and the encoder's final output as `K, V` to attend over the source sequence.\n- FFN processes each position independently: `W2 * act(W1 * x + b1) + b2` (typically ReLU or GELU).\n- Common mistake: thinking the decoder runs one token at a time during training—it processes the full target sequence in parallel via teacher forcing and the causal mask, and only runs autoregressively at inference.\n- Trade-off: dropping cross-attention (decoder-only) simplifies scaling and KV-caching for general LLMs, while keeping it (encoder-decoder) is more parameter-efficient for conditioned tasks like translation."
    }
  ]
}

/** The same card while the deep model is still working. */
export const cardDecoderAdding: Card = {
  ...cardDecoder,
  sections: [{ ...cardDecoder.sections[0], detail: '', deepening: true }]
}

/** "Solve what's on screen", then a follow-up without code: the code stays visible under it. */
export const cardRainWater: Card = {
  id: 'c8',
  createdAt: now - 3 * MIN,
  updatedAt: now - 90_000,
  source: 'screen',
  status: 'done',
  sections: [
    {
      id: 's8',
      prompt: 'Trapping Rain Water',
      say: 'I would use two pointers from both ends, keeping the highest wall seen on each side.',
      points: pts([
        ['Move the side with the lower max', true],
        ['Water at i = side max minus height', false]
      ]),
      detail: [
        'Two pointers, one pass.',
        '',
        '```python',
        'def trap(height: list[int]) -> int:',
        '    left, right = 0, len(height) - 1',
        '    left_max = right_max = water = 0',
        '    while left < right:',
        '        if height[left] < height[right]:',
        '            left_max = max(left_max, height[left])',
        '            water += left_max - height[left]',
        '            left += 1',
        '        else:',
        '            right_max = max(right_max, height[right])',
        '            water += right_max - height[right]',
        '            right -= 1',
        '    return water',
        '```'
      ].join('\n')
    },
    {
      id: 's9',
      prompt: 'Why is that O(1) space?',
      say: 'It only keeps two indexes and two running maxima, no prefix arrays, so space stays constant.',
      points: pts([
        ['Prefix-max arrays would be O(n)', false],
        ['Each index is visited once: O(n) time', false]
      ]),
      detail: ''
    }
  ]
}

/** A side question that arrived while the user types the code: it waits, shown as a peek. */
export const cardSide: Card = {
  id: 'c9',
  createdAt: now - 15_000,
  source: 'auto',
  status: 'done',
  sections: [
    {
      id: 's10',
      prompt: 'Have you used Kafka in production?',
      say: 'Yes, at Ledgerly settlement events went through Kafka, which is what took us from a nightly batch to under two minutes.',
      points: pts([
        ['Event-driven settlement pipeline at Ledgerly', false],
        ['Nightly batch to under two minutes', false],
        ['Failed payouts down about 40%', false]
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
    case 'deep':
      return { ...live, cards: [cardAbout, cardLimiter, cardDecoder], activeCardId: 'c7' }
    case 'adding':
      return { ...live, cards: [cardAbout, cardLimiter, cardDecoderAdding], activeCardId: 'c7' }
    case 'hold':
      return {
        ...live,
        cards: [cardAbout, cardRainWater, cardSide],
        activeCardId: 'c8',
        queuedCardId: 'c9',
        partial: { you: true, them: false }
      }
    case 'many':
      return { ...live, cards: [cardAbout, cardLimiter, cardSeven], activeCardId: 'c6' }
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
    cards: [cardAbout, cardLimiter, cardSeven],
    summary: '',
    recap: i === 0 ? recap : undefined
  }))
}

export const demoRecap = recap

export const demoProfile = [
  'Snapshot',
  'Priya Raman, senior backend engineer, 6 years, Bengaluru. Payments infrastructure, most recently at Ledgerly.',
  '',
  'Experience',
  '- Ledgerly (2023 to now): led the move of settlement from a nightly batch to an event-driven pipeline, under 2 minutes, failed payouts down 40%.',
  '- Shopwise (2020 to 2023): search APIs, p95 latency from 900 ms to 210 ms.',
  '',
  'Projects and stories',
  '- Settlement rewrite: nightly batch kept missing cut-offs; I designed the event pipeline on Kafka; payouts now settle in under 2 minutes.',
  '- Idempotency keys: pushed back on launching payouts without them; 0.4% of staging payouts retried; we delayed one week (check: launch date).',
  '',
  'Skills',
  '- Go, TypeScript, Postgres, Redis, Kafka',
  '',
  'Motivation and preferences',
  '- Wants an API platform used by thousands of developers. Notice period 60 days.',
  '',
  'How I speak',
  '- Short, concrete sentences with numbers; starts with the result.'
].join('\n')

const LONG_TOKEN =
  'https://example.com/careers/senior-backend-engineer/applications/2026/very-long-tracking-url?utm_source=linkedin&utm_medium=social&utm_campaign=hiring-sprint-q4-emea'
export const stressText = {
  title:
    'Northwind Analytics International Holdings · Senior Principal Backend and Platform Engineering Lead (Payments Infrastructure) · Hiring manager round with the VP of Engineering',
  token: LONG_TOKEN,
  message: `Call audio stopped because the capture helper exited unexpectedly (code 69, ${LONG_TOKEN}). Reconnecting automatically, this can take up to thirty seconds.`,
  error: `Vertex rejected the request: PERMISSION_DENIED on projects/sidekick-dev-4821/locations/global/publishers/google/models/gemini-3.5-flash:streamGenerateContent. ${LONG_TOKEN}`
}

/** Stress variants of the seeded state (?stress=1). */
export function stressLive(live: LiveState): LiveState {
  if (live.session !== 'live') return live
  const long: CardSection = {
    id: 'st1',
    prompt: `Walk me through ${stressText.title} and how you would handle it`,
    say: `I'd start from ${LONG_TOKEN} and then explain the settlement pipeline end to end, because the numbers in that document drive every trade-off.`,
    points: pts([
      [`Unbroken token: ${'Supercalifragilistic'.repeat(4)}`, false],
      [
        'A perfectly ordinary point that should wrap onto a second line when the card is narrow, with enough words to need it',
        true
      ]
    ]),
    detail: [
      '| region | sync interval | overshoot bound | notes about the trade-off we accepted |',
      '| --- | --- | --- | --- |',
      '| eu-west | 1 s | 300 requests | acceptable for a public API, revisit when we add a fourth region |',
      '',
      '```ts',
      'const reallyLongIdentifierNameForOvershootBound = regionsCount * ratePerSecondPerRegion * syncIntervalSeconds * safetyFactor',
      '```',
      '',
      LONG_TOKEN
    ].join('\n')
  }
  const card: Card = { id: 'cst', createdAt: now, source: 'auto', status: 'done', sections: [long] }
  const them = (t: string, i: number): Utterance => ({
    id: `ux${i}`,
    speaker: i % 2 ? 'you' : 'them',
    text: t,
    startedAt: now - 30_000 + i * 1000,
    endedAt: now - 29_000 + i * 1000
  })
  return {
    ...live,
    title: stressText.title,
    utterances: [
      ...live.utterances,
      them(`Here is the posting: ${LONG_TOKEN}`, 0),
      them(`pasted:${'x'.repeat(120)}`, 1)
    ],
    cards: [...live.cards, card],
    activeCardId: 'cst',
    queuedCardId: null,
    audio: { ...live.audio, system: 'error', message: stressText.message }
  }
}

export function stressSessions(): Session[] {
  const base = seedSessions()
  return Array.from({ length: 30 }, (_, i) => ({
    ...base[i % base.length],
    id: `st-${i}`,
    title: i % 3 === 0 ? stressText.title : `${base[i % base.length].title} #${i}`,
    startedAt: now - i * 86_400_000,
    endedAt: now - i * 86_400_000 + 40 * MIN
  }))
}

export const stressFiles = Array.from({ length: 12 }, (_, i) => ({
  id: `sf${i}`,
  name: `Priya_Raman_Staff_Engineer_Resume_and_Portfolio_Final_v${i}_REVISED_for_Northwind.pdf`,
  mimeType: 'application/pdf',
  path: `/demo/f${i}.pdf`,
  bytes: 182_400 * (i + 1)
}))
