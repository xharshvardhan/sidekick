# Sidekick

Sidekick sits beside you on a call. It hears both sides (your mic and whatever your Mac plays),
transcribes them, and when the other person asks you something it puts a short card on screen:
one sentence you can say right now, plus a few talking points. It stays quiet on small talk.
macOS 14+ on Apple Silicon. Uses Google Vertex (Gemini) for transcription and answers.

## First run

1. Build and install the app: `npm run app` (installs `~/Applications/Sidekick.app`), then open it.
2. Setup opens with three checks:
   - **Microphone**: click the fix button, allow Sidekick in the macOS prompt.
   - **Screen & System Audio Recording**: click the fix button. Sidekick asks macOS first (so it
     shows up in the list), then opens System Settings. Turn Sidekick on. Capture starts by itself
     within a few seconds; if macOS asks to quit and reopen Sidekick, do that.
   - **Vertex connection**: filled in from `.env.local` automatically; otherwise use Settings → Vertex.
3. Say something and click "Play test sound" to see both level meters move. Finish (or "Skip for now").

## How a session works

On Home, give the call a title, pick a preset (Interview, Sales call, Meeting, Custom), add notes and
files (resume, job description, deck) and press Start. The overlay appears at the top of the screen.
When they finish a question, a card streams in; follow-ups add a section to the same card. A new card
waits ("Next" bar) while you are still talking. Points you have already said are dimmed.
For questions that need depth (explain an architecture, design a system, draw something, a coding problem) the card
comes first and a stronger model adds a diagram or the code under it a few seconds later ("Adding detail…").
A card with code (or from "solve what's on screen") stays put for 10 minutes while you type from it: new cards wait
in the "Next" bar, which then shows their answer, and ⌥⇧] switches. End the
session to get a recap in History. Put facts about yourself in Settings → Profile: Sidekick never
invents your experience, so without them it gives you a sentence with [blanks] to fill.

## Hotkeys

| Keys  | Action                                      |
| ----- | ------------------------------------------- |
| ⌥⇧A   | Help me with what was just said (or ask)    |
| ⌥⇧S   | Capture the screen and solve what is on it  |
| ⌥⇧D   | Add in-depth detail to the current card     |
| ⌥⇧[   | Previous card                               |
| ⌥⇧]   | Next card                                   |
| ⌥⇧P   | Pin the current card                        |
| ⌥⇧H   | Show or hide the overlay                    |
| ⌥⇧M   | Switch between app window and overlay only  |
| ⌥⇧L   | Pause or resume listening                   |

All are editable in Settings → Hotkeys.

## Development

| Command                  | What it does                                                         |
| ------------------------ | -------------------------------------------------------------------- |
| `npm run dev`            | Run the app from source with hot reload                              |
| `npm test`               | Unit tests (segmenter, echo guards, cards, protocol, races)          |
| `npm run sim`            | Scripted calls through the real pipeline with real Vertex calls      |
| `SIM_NO_PROFILE=1 npm run sim` | Same, with an empty profile (checks nothing is invented)       |
| `npm run shots`          | Screenshots of every screen and overlay state into `shots/`          |
| `npm run deep`           | Deep-dive questions through cue + deep pass with real models: outputs and timings |
| `npm run app`            | Build `Sidekick.app` and install it in `~/Applications`              |
| `npm run typecheck`      | TypeScript checks                                                    |

## Replay: test the director on a real recording

Replays a recorded call through the real director (same prompt, parser, card policy, coverage and rolling summary)
in virtual time, then scores it. A full hour takes a few minutes. Keep recordings outside the repo (`*.wav` and
`data/` are gitignored anyway).

A recording folder holds:

| File | Needed | Format |
| --- | --- | --- |
| `turns.json` | yes | `{"turns":[{"speaker":"you"\|"them","start":s,"end":s,"text":"…","words":[["word",start,end],…]}]}`, seconds; any transcript with word timings (e.g. a meeting-notes export) |
| `call.wav` | recommended | the call, both voices mixed, 16 kHz mono PCM16, same time base as `turns.json` |
| `brief.json` | yes | a `Brief` (`src/shared/types.ts`): `{"title","preset":"interview","notes":"","files":[],"details":[{"label","value"}]}` |
| `profile.txt` | optional | your "About me" (e.g. from your resume); `--no-profile` replays without it |

```
npm run replay:prepare -- <dir>   # fixes speaker labels → call.json, plus you.pcm/them.pcm for SIDEKICK_FAKE_AUDIO
npm run replay:gold -- <dir>      # drafts gold.json: a label for every point where they stop talking. Review it by hand.
npm run replay -- <dir> [--from mm:ss] [--to mm:ss] [--out name] [--no-judge] [--no-profile] [--cue-model id]
npm run replay -- <dir> --rescore <name>   # score a saved run again after editing gold.json
```

`gold.json` is a list of `{t, said, label: "cue"|"optional"|"none", kind?: "new"|"extend", note?, answer?}`: `cue` = you
needed help (a question, a pushback, a task, "any questions?"), `optional` = a card is fine but not needed, `none` =
backchannel, small talk, mid-thought or explanation. Each run writes `<name>.json` and `<name>.md` into the recording
folder: cue recall, false cues on `none` moments, new-vs-extend accuracy, sections per card, latency, and card quality
scored 1–5 by an LLM judge (answers the ask, speakable first line, technically right, grounded, not repeating you).
To hear the same call through the full audio pipeline: `SIDEKICK_FAKE_AUDIO=<dir> npm run dev` (plays `you.pcm` /
`them.pcm` in real time; add a `brief.json` there to auto-start the session).

Dev and the installed app share one data folder, `~/Library/Application Support/sidekick`
(settings, sessions, and `sidekick.log`, which is the first place to look when something goes wrong).
Only one of them can run at a time, unless the dev run gets its own folder: `SIDEKICK_DATA=<dir> npm run dev`
(copy `settings.json` into it first).

## Audio capture and echo cancellation

A small native helper (`native/audiocap.swift`) captures two streams: everything the Mac plays
(the other side; needs Screen & System Audio Recording) and your microphone. Each stream is cut into
speech segments by an energy detector and sent to Gemini for transcription.

The microphone runs through Apple's voice processing, which removes the speakers' sound from the mic,
so you can use speakers instead of headphones. Whatever faint echo survives is dropped by an energy
gate (quiet mic sound while the call is loud) and by a text check (your "utterance" overlaps theirs
and repeats their words).

## Known limits

- macOS only, one user, no accounts. Needs a Vertex project and a service-account key.
- Cards arrive about 2 s after they stop talking; Vertex sometimes takes longer.
- On speakers without echo cancellation (or if it fails), some echo may still be transcribed; use headphones.
- "Hide from screen share" and keeping Sidekick out of its own screenshots rely on macOS content
  protection, which some capture tools ignore.
- The app is ad-hoc signed for this Mac only; it is not notarized for distribution.
