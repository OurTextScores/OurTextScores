# Walkthrough videos

Scripted screen recordings of the product, built so a video can be made again when the UI
changes instead of being re-shot by hand.

```bash
cd frontend
node scripts/walkthrough/run.mjs editor --dry                  # perform every scene quickly, screenshots only
node scripts/walkthrough/run.mjs editor --dry --scene marks    # ...or just one
node scripts/walkthrough/run.mjs editor --record               # record takes (real time)
node scripts/walkthrough/run.mjs editor --assemble             # build the video from the takes
node scripts/walkthrough/run.mjs editor --all                  # record everything, then assemble
node scripts/walkthrough/run.mjs editor --voice                # make the narrator's clips before recording
node scripts/walkthrough/run.mjs editor --voice-check          # ...and have each one transcribed and compared
node scripts/walkthrough/run.mjs editor --calibrate            # check audio and picture timing
```

It needs the site on `http://localhost:3000` (the editor is recorded from
`/score-editor/index.html`; set `WALKTHROUGH_EDITOR_BASE` to record another build), Playwright's
Chromium, and `ffmpeg`.

Takes and finished videos are large and go to `$WALKTHROUGH_OUT` (default
`~/workspace/artifacts/walkthroughs/<video>/`), not into git:

| Folder | Holds |
| --- | --- |
| `dry/<scene>/snaps/` | screenshots from a dry run |
| `takes/<scene>/` | recorded frames, `take.json`, audio |
| `voice/` | the narrator's clips, one per line, reused until the line changes |
| `build/` | one clip per scene, the joined picture, the sound tracks, `timeline.json` |
| `final/` | see below |

What `final/` holds, for a video called `editor`:

| File | Captions burned in | Narrator |
| --- | --- | --- |
| `editor.voice.mp4`, `editor.voice.webm` | yes | yes |
| `editor.voice.clean.mp4` | no | yes |
| `editor.mp4`, `editor.webm` | yes | no |
| `editor.clean.mp4` | no | no |

plus `editor.srt` and `editor.vtt` (captions as files), `chapters.txt`, `poster.png` and
`script.md` (every line, with the spoken wording where it differs from the written one).

## How it works

- **Picture.** Headless Chromium, laid out at 1280×720 and rendered at 1.5×, so the frame is a
  true 1920×1080 with a UI large enough to read. Frames come from the browser's own screencast
  and are encoded by ffmpeg.
- **Pointer and keys.** A headless browser draws no pointer. `lib/overlay.mjs` draws one that
  follows the real mouse events, ripples on click, and shows each key as it is pressed.
- **Sound.** The same overlay taps the page's Web Audio output through an AudioWorklet and
  stamps every run of sound with the wall clock, so playback is heard in the video and stays in
  sync even though the editor suspends its audio engine between sounds.
- **Captions** are part of each scene script (`t.caption('…')`). They attach to the moment in
  the script, not to a time, so a re-recorded scene keeps its captions in the right place.
- **Narration.** Each caption is also a line for the narrator. `lib/voice.mjs` has a
  text-to-speech service read it (OpenAI's, voice `marin`, by default) and keeps the clip. The
  recorder knows how long every clip is and holds a caption until its line could have been
  said, so scenes are paced by their narration and the same takes serve the version with a
  voice and the one without. In the mix, the app's own sound drops while the narrator speaks.
  Write `t.caption('Save with Ctrl+S.', { say: 'Save with Control S.' })` where the eye and the
  ear need different words.

  Making clips needs `OPENAI_API_KEY` (or `WALKTHROUGH_TTS_KEY`); a line costs a fraction of a
  cent. Without a key, clips already made are used and missing ones are reported. A speech
  model now and then drops a sentence, which is why `--voice-check` exists: it transcribes each
  clip and remakes one that came out short. Change the voice with `WALKTHROUGH_VOICE`,
  `WALKTHROUGH_VOICE_MODEL` or `WALKTHROUGH_VOICE_STYLE`; clips are then made again.

  The order that keeps a recording from being paced by guesses: `--dry` (so the scenes say what
  their lines are), `--voice-check`, `--record`, `--assemble`.
- **Waiting** (a file loading, a comparison opening) is wrapped in `t.cut(…)` and removed in the
  edit, with a short "skipped" label so the cut is visible. Nothing is sped up.
- **Scenes are separate takes**, each from a fresh browser, with a `setup` that is not recorded.
  One scene can be re-recorded without the others.

## Writing a scene

A scene is `{ id, chapter, setup(t), run(t) }` in `videos/<video>/scenes/`, listed in that
video's `index.mjs`. Use `t` rather than the Playwright page for anything the viewer should
see: `t.click`, `t.hover`, `t.drag`, `t.key`, `t.text`, `t.caption`, `t.callout`, `t.cut`,
`t.hold`. `t.snap('name')` saves a screenshot in a dry run and does nothing when recording.

Work with `--dry`, look at the screenshots, then record. Keep to what the product really does:
if something does not work on camera, change the scene or leave it out.

Never log, print or save a network request from a scene. A request to the AI assistant carries
the user's API key in its body.

## The editor video

`videos/editor/`. Recorded from the editor the site serves at `/score-editor/`.

The `ai` scene makes a real request to the assistant, which needs two things:

- an OpenAI key in `WALKTHROUGH_AI_KEY` (or `OPENAI_API_KEY`). The editor is bring-your-own-key;
  the scene types the key into the panel during `setup`, which is not recorded, and the field
  is a password field, so the recording shows dots. Check the frames anyway before publishing;
- the editor API, reachable through the site's `/api/score-editor` proxy. For a site run with
  `npm run dev`, that is OTS_Web's own server on another port with `OTS_API_AUTH_TOKEN` equal to
  the site's `SCORE_EDITOR_API_TOKEN`, and `SCORE_EDITOR_API_ORIGIN` pointing at it.

Without a key the video uses `ai-tour` instead, which opens the panel and makes no request.

The scene stops at the proposal. Applying it fails on the first try with "The score changed
after this proposal was generated": opening the comparison lays the score out again, and the
check that guards Apply reads the changed layout numbers as an edit. That is an editor bug,
not something a scene should work around.

Two things about this editor that scenes have to respect:

- Its SVG lists notes in the engine's order, not the music's. `inReadingOrder()` in
  `videos/editor/editor.mjs` returns them left to right, system by system.
- It ignores the first click on the score after a note has been dragged. Put a drag last among
  a scene's clicks on the score.
