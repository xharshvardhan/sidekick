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
waits ("Next" bar) while you are still talking. Points you have already said are dimmed. End the
session to get a recap in History. Put facts about yourself in Settings → Profile: Sidekick never
invents your experience, so without them it gives you a sentence with [blanks] to fill.

## Hotkeys

| Keys  | Action                                      |
| ----- | ------------------------------------------- |
| ⌥⇧A   | Help me with what was just said (or ask)    |
| ⌥⇧S   | Capture the screen and solve what is on it  |
| ⌥⇧D   | Go deeper on the current card               |
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
| `npm run app`            | Build `Sidekick.app` and install it in `~/Applications`              |
| `npm run typecheck`      | TypeScript checks                                                    |

Dev and the installed app share one data folder, `~/Library/Application Support/sidekick`
(settings, sessions, and `sidekick.log`, which is the first place to look when something goes wrong).
Only one of them can run at a time.

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
