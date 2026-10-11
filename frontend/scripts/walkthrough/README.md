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
| `build/` | one clip per scene, and `master.mp4` |
| `final/` | `<video>.mp4` and `.webm` with captions, `<video>.clean.mp4` without, `.srt`, `.vtt`, `chapters.txt`, `poster.png`, `script.md` |

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

Two things about this editor that scenes have to respect:

- Its SVG lists notes in the engine's order, not the music's. `inReadingOrder()` in
  `videos/editor/editor.mjs` returns them left to right, system by system.
- It ignores the first click on the score after a note has been dragged. Put a drag last among
  a scene's clicks on the score.
