# Sidekick: build spec

Sidekick is a friend sitting beside you on a call. It hears both sides, knows your context, and
puts the right thing on screen at the right moment, without you touching anything.
macOS only (Apple Silicon, macOS 14+). Personal tool for one user.

The contract between processes is `src/shared/types.ts`. Read it first.

## What is already proven (do not redo)

- `native/audiocap.swift` → `resources/bin/audiocap` (built by `npm run native`). Writes raw
  16 kHz mono PCM16 to stdout; status lines (`ready`, `error: …`, `stopped: …`) to stderr.
  - `audiocap` (no args): system audio, everything the Mac plays. Needs Screen Recording permission.
  - `audiocap mic`: microphone with Apple voice processing. Echo of the speakers is removed
    (measured: speaker bleed rms 3800 → 15). `audiocap mic --no-aec` is the raw mic.
  - Electron's own `getDisplayMedia` loopback is blocked by a separate permission. Do not use it.
- Vertex works through `@google/genai` with `{vertexai: true, project, location}` and
  `GOOGLE_APPLICATION_CREDENTIALS`. Dev values are in `.env.local` (gitignored); load them in dev
  and seed Settings from them on first run.
- Measured model latency (global region):
  - Transcription: `gemini-3.5-flash-lite` ≈ 1.4 s for a 3 s clip.
  - Cues: `gemini-3.5-flash` with `thinkingConfig: {thinkingBudget: 0}` ≈ 0.9 s to first word.
  - Deep answers: `gemini-4-hydrogen` with `thinkingConfig: {thinkingLevel: 'low'}` ≈ 3.5 s to first word.
  - `gemini-4-*` reject `thinkingBudget`; `gemini-3.5-*` accept it. Default models: stt
    `gemini-3.5-flash-lite`, cue `gemini-3.5-flash`, deep `gemini-4-hydrogen`.

## Architecture

```
main process (TypeScript)                                   windows (React)
  audio/   spawn audiocap x2 → Segmenter (VAD) per channel    app window: Home, Live, History, Settings, Setup
  stt/     segment → text (Gemini)                            overlay window: the in-call card
  convo/   Conversation store (utterances, summary)
  director/ decides when to help; generates cards             preload exposes a typed `window.sidekick`
  sessions/ JSON files in app.getPath('userData')/sessions      .invoke(channel, ...args) / .on(event, fn)
  settings/ JSON file, never rewritten wholesale by accident
  windows/ app window + overlay window + mode + hotkeys
  ipc.ts   implements `Api`, emits `Events`
```

Main owns everything. Windows render `LiveState` and call `Api`. Switching windows never loses state.
Keep it small: no DI framework, no event bus library, plain modules and a tiny typed emitter.

### Audio and segmentation
- One `audiocap` child per channel, restarted with backoff if it exits. Map stderr to `AudioHealth`.
  If the system channel reports an error mentioning permission/TCC, set `system: 'denied'`.
- Segmenter per channel: adaptive energy VAD (track noise floor; speech = rms > max(floor×3, 120)),
  300 ms pre-roll, end a segment after 550 ms of silence or 15 s. Drop segments with < 250 ms speech. A segment only
  starts (`speechStart`) after 100 ms of unbroken speech frames, so typing and clicks never open one.
  Emit `speechStart`, `speechEnd(segment pcm, startedAt, endedAt)`. Publish levels 8×/s.
  Timestamps come from sample counts anchored to each helper's `ready` time, not from `Date.now()`
  per chunk; exclude the pre-roll when comparing overlap between channels.
- AEC fallback: only if every mic sample is exactly 0 for 3 s while the system channel has audio
  (a wedged voice-processing unit), restart the mic with `--no-aec` and show a persistent warning
  (`AudioHealth.message`). A quiet user must never trigger it.
- When running `--no-aec` (fallback or setting): (a) energy gate: ignore mic speech while the
  system channel is loud and the mic level is below ~0.6× the system level; (b) text echo guard:
  drop a `you` utterance that overlaps a `them` utterance in time and shares ≥ 60% of its words.

### Transcription
- Each segment → WAV → STT model, prompt: verbatim transcript; `NO_SPEECH` when there is no clear speech
  (silence, typing, breathing, music, noise); never sound tags like `<noise>`. Language hint: `settings.language`, or
  else the script of the last 6 transcript lines (Latin → English, may mix Hindi; Devanagari → Hindi), "switch only if
  the speech clearly does". The earlier lines themselves are not sent: given them, the STT model copies them into its
  output (measured). Up to 3 in flight per channel; results inserted into the conversation ordered by `startedAt`.
- Dropped results (never stored, never in coverage or model context): `NO_SPEECH`, sound tags, timestamps ("00:00"),
  pure filler ("um", "uh", "mhm", "hmm", "uh-huh"), and known hallucinations on near-silent audio ("you", "Thank you.").
  "yes", "okay", "no" are kept. The backchannel skip and card queueing use segment timing, not text, so they are unchanged.

### The director (the important part)
Goal: behave like a sharp friend who knows when to speak up and when to stay quiet.

**When it runs**
1. `them` finishes speaking (`speechEnd`). Start immediately, do not wait for the transcript:
   send the untranscribed segment audio as `inlineData` together with the text context
   (audio fast path; this saves ~1.4 s). The transcript arrives in parallel for the record.
   Attach every segment still waiting for its transcript, from either speaker, in time order,
   each preceded by a text label (`You (audio):` / `Them (audio):`), so fast exchanges lose nothing.
2. If `them` starts speaking again before the answer has shown its first line, cancel and wait for the
   next `speechEnd`, then run with all pending audio (also in long monologues: a pause is not a question).
3. Skip without a model call when the segment is a backchannel: < 0.7 s long while `you` spoke
   in the last 3 s.
4. Manual triggers always run: `cue:ask` (typed question, or empty = "help me with what was just
   said"), `cue:screen` (fresh screenshot attached, downscaled to ≤ 1600 px JPEG), `cue:deeper`
   (deep model, writes the active card's newest section's `detail`; a no-op with a toast when that section already
   has deep detail or one is being written). A `screen` card always gets the deep pass with the screenshot (no `+deep`
   needed), with its own task: the exact next commands/values/code visible or implied on screen, in order, in fenced
   blocks, short.
6. Deep pass: when a cue ends with `+deep`, the director runs the deep model on that section automatically
   (`deepen`). It runs beside cues (never blocks or cancels them), the still-streaming cue no longer writes that
   section's detail, a manual trigger that takes over cancels deep passes on other cards, and a cancelled or failed
   pass restores the old detail. While it runs the section has `deepening: true`. The deep task asks for what an
   expert would slide over: for architectures/flows a plain-ASCII diagram in a ```` ```text ```` fence (one column, ≤ 50
   columns asked, ≤ 58 fit), every stage with shapes/data, then 4–7 bullets (formula, common mistake, trade-off); for
   coding problems approach, code, complexity, 2 edge cases. `npm run deep` measures it with real models.
5. One generation at a time per trigger kind; a newer trigger cancels the older stream.

**What it sends** (cue model, streaming, no thinking), strictly ordered from most stable to most
changing so implicit caching applies: system prompt for the preset + profile + brief notes + brief
files (inlineData for pdf/images, text for the rest) → rolling summary → the last ~30 utterances
labelled `Them:` / `You:` → the active card (prompts and points, with covered marks) → the new audio.

**What it returns**: a line protocol that can be parsed while streaming:
```
@none        ← nothing needed (small talk, they are still setting up, you're doing fine)
@new         ← new topic: start a new card
@extend      ← follow-up on the active card's topic: add a section to it
> <one sentence to say right now, ≤ 22 words, first person>
- <talking point, ≤ 12 words>
- <talking point>            (2 to 4 points, in the order to say them)
? <what they asked, ≤ 10 words>     ← the section's `prompt` label, after the points
+deep        ← optional: explain/derive/compare/design/draw an architecture, algorithm or system, or a coding
               problem; the cue then writes no detail and the deep pass adds it (accepted on any line, also
               `@new +deep`; a partial `+de` never shows)
## 
<optional detail in markdown: code, numbers, a worked example>
```
The directive is bare and the `say` line comes straight after it, so the first readable words arrive
as early as possible; the label comes later (show the section without a label until it arrives).
Write a streaming parser for this with unit tests (partial lines, missing sections, junk before `@`).
The prompt must make the model: answer as the user would say it, grounded in the brief/profile
(never invent facts about the user; facts come from the profile, first-person material the user wrote or attached,
e.g. a resume or "my experience" brief file, and what they said; material about the other side, like a job description,
is not evidence; the user's opinions and reactions are facts too; if the sources lack it, give a structure with blanks);
stay silent on small talk and on statements that need no reply; account for what the user already
said (do not repeat covered points; for a follow-up, build on their answer).

**How cards behave** (so the user's eyes never have to hunt)
- The newest section's `say` line is always the first line of the card. Streaming only appends.
- `@extend`: add a section (at most 3 per card; a fourth follow-up starts a new card). The overlay shows the newest section on top and older sections collapsed
  to their `prompt` line *below* it; the previous section collapses only once the new `say` line has
  finished streaming.
- `@new` goes to `queuedCardId` (not shown as the active card) when any of these hold: the user is
  speaking (`partial.you`) or spoke in the last 2.5 s; the active card is < 4 s old; pinned; the active card
  holds (`cardHolds` in `src/shared/hold.ts`: a `screen` card or one whose detail has a code fence, i.e. any fence
  not tagged `text`, last updated < 10 min ago). A holding card is never replaced on silence: the user steps to the
  queued card (⌥⇧]); manual triggers still take over at once.
  Promote it when the user has been silent for 2.5 s and not pinned, or on `cue:step(1)`.
  Otherwise it becomes active immediately. If the user starts speaking before the first line of a
  new card arrives, route it to the queue rather than flashing it.
- `thinking` turns true only 400 ms after a trigger and only if the generation is still alive, so
  pauses in their speech do not make the status flicker.
- Coverage: after each `you` utterance, mark a point covered when ≥ 50% of its content words
  (stopwords removed, light stemming) appear in what the user has said since that section started.
  No model call.
- `cue:step` walks card history; `cue:pin` freezes the active card.

**Memory**: every 3 minutes or 15 new utterances, fold older utterances into `summary` with the cue
model (keep names, numbers, commitments, questions asked). The prompt uses summary + recent tail.

### Sessions
- `session:start(brief)` starts capture and the director; `session:end` stops capture, saves, and
  generates a `Recap` in the background with the deep model. Autosave every 10 s while live.
- History lists `SessionMeta`; a session page shows transcript, cards and recap.

### Windows, modes, hotkeys
- App window: normal macOS window, `titleBarStyle: 'hiddenInset'`, 1100×740, min 880×600.
- Overlay window: `type: 'panel'`, frameless, `vibrancy: 'hud'`, always on top (`'floating'`), visible
  on all workspaces including fullscreen, does not take focus from the call app unless clicked,
  resizable, draggable by its header. Default: top-center, 12 px under the menu bar, 560×340. Remember bounds.
  `setContentProtection(settings.overlay.hideFromScreenShare)`, off by default.
- Mode `app`: app window shown; overlay shown when a session is live and `showOnStart`.
  Mode `overlay`: app window hidden, overlay only. `toggleMode` switches. The dock icon always stays.
  No disguised process names or fake branding anywhere.
- Global hotkeys from `settings.hotkeys`; defaults: ask ⌥⇧A, screen ⌥⇧S, deeper ⌥⇧D,
  prevCard ⌥⇧[, nextCard ⌥⇧], pin ⌥⇧P, toggleOverlay ⌥⇧H, toggleMode ⌥⇧M, toggleListening ⌥⇧L.
  Report registration failures to the UI. `requestSingleInstanceLock`.
- Security: `contextIsolation: true`, `sandbox: true` where the preload allows, no remote content,
  no local servers.

### Dev and test tooling (required, this is how we verify without a human)
- `SIDEKICK_FAKE_AUDIO=<dir>`: instead of spawning `audiocap`, play `you.pcm` / `them.pcm`
  from that dir into the two channels in real time.
- `npm run sim -- scripts/sim/interview.json`: a scripted two-person call. Each line
  `{speaker, text, gapMs}` is rendered with macOS `say` to 16 kHz PCM, laid out on two timelines,
  and run through the real pipeline (segmenter → STT → director, real Vertex calls) headlessly.
  Prints a timeline with latencies (speech end → first card line) and asserts expectations in the
  script (`expect: 'card' | 'none' | 'extend'`, `blanks: true | false` for the say line's [blanks]). `files` attaches
  brief files through the same `briefParts` path as the app. Scripts: interview, sales call, small talk, usability
  study (first-person context file, empty profile).
- `npm run shots`: launches the app with seeded demo data, saves PNGs of every route and the overlay
  (light and dark) to `shots/` via `webContents.capturePage()`. Used to review the UI.
- `vitest` unit tests: segmenter, echo guard, coverage, protocol parser, card policy (mock model).
- `npm run typecheck` and `npm test` must pass.

## UI

Built with `@openai/apps-sdk-ui` (Tailwind 4) components and tokens; `lucide-react` icons where the
kit lacks one. System font stack. Light and dark from one token set. Calm, dense, no gradients, no
glass effects in the app window, no emoji. Every control has a label or tooltip with its hotkey.
Every error is visible in the window where it happened (inline or toast), never only in logs.

### App window
Left sidebar: Home, Live (dot when live), History, Settings. Bottom: audio status and mode switch.
- **Setup** (first run, also under Settings): three checks with live results and a fix button each:
  Microphone, Screen & System Audio Recording, Vertex connection. Two live level meters ("You",
  "Them") and a "Play test sound" button so the user sees the Them meter move. Finish only when
  all pass, with a "skip for now".
- **Home**: "Start a session" card: title, preset (Interview / Sales call / Meeting / Custom),
  notes box ("Role, company, what you want out of this call…"), file drop (resume, JD, deck),
  Start button. Below: recent sessions.
- **Live**: left = transcript as a conversation (You right-aligned, Them left, merged turns, a
  subtle "speaking…" indicator per side). Right = the active card rendered large, with card history
  below. Bottom: Ask box ("Ask anything, or press ⌥⇧A for help with what was just said"),
  screenshot button, auto-cue toggle, pause, end.
- **History**: list → session page with Recap, Transcript, Cards tabs.
- **Settings**: Profile ("About me", large text box), Answers (auto-cue, style, language), Models,
  Overlay (show on start, opacity, text size, hide from screen share with a note that some capture
  tools ignore it), Audio (echo cancellation, meters), Hotkeys (editable), Vertex (project,
  location, key path, Test button), Setup checks.

### Overlay (the in-call experience; spend the most care here)
- Header (drag handle, 28 px): live dot + timer, two tiny level bars (You/Them), status text
  ("Listening", "Thinking…", "Paused"), pin, card position ("2/5"), switch-to-app button.
- Body: the active card.
  - Section prompt in small muted caps ("THEY ASKED · Design a rate limiter").
  - `say` line: 17 px, semibold, high contrast. The first thing the eye lands on.
  - Points: 14.5 px, one per line, covered points dimmed with a check. Max line length ~60 chars.
  - Detail: prose collapsed to 3 lines with "more"; details with a code block or diagram open fully (the body
  scrolls). Code blocks and diagrams never wrap: they keep their columns and scroll sideways.
  While the deep pass runs: a quiet "Adding detail…" shimmer under the points.
- Follow-up on a code card: when the newest section has no code, the latest code stays visible under it
  ("CODE · from <prompt>") until the earlier sections are opened.
  - Older sections collapsed to a one-line prompt below a hairline, click to expand.
  - Streaming shows a soft caret; no layout jumps; no auto-scroll above the reading position.
- Queued card: a slim bar at the bottom, "Next: <prompt> · ⌥⇧]", never replaces what is being read. Behind a
  holding card it becomes a peek: the label, the say line (up to 3 lines) and the points on one line.
- Idle (no card yet): one line of live caption of the last thing they said, and hints for ⌥⇧A / ⌥⇧S.
- Ask input: hidden by default; ⌥⇧A with the overlay focused, or the small Ask button in the
  header, opens it as a footer row. No hover-triggered layout changes anywhere; the overlay's height
  never changes on its own.
- Older sections sit below the newest one (see card behaviour), collapsed to one line each.
- Errors appear as a single inline line in the body.

## Definition of done
1. `npm run typecheck`, `npm test` pass; `npm run sim` passes all three scripts and prints latencies.
2. `npm run dev` starts with no console errors; Setup shows real permission state and moving meters.
3. A live session shows You/Them transcript, auto cards for questions, none for small talk.
4. `npm run shots` produces screenshots of every screen in both themes.
