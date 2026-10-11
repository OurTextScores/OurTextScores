import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { buildSceneClip } from './assemble.mjs';
import { launchBrowser, performScene } from './recorder.mjs';

/**
 * Measures the recorder against itself: a page plays five clicks, each with a full-screen
 * flash, and suspends its audio context part-way (as the editor does between sounds). Each
 * click and flash is then looked for in the recorded audio and frames.
 *
 * Prints how far the recorded sound and picture are from when the page made them. Both should
 * be within about one frame (33 ms); the audio figure is what WALKTHROUGH_AUDIO_LATENCY corrects.
 *
 * Then it does the same through the edit: a second take with waits cut out of it, before and
 * between the clicks, is built into a clip the way a scene is, and each click is compared with
 * its flash in that clip. A cut that the picture and the sound do not share shows up here as
 * every later click being late by the length of the cut.
 */
export async function calibrate({ workDir }) {
  const dir = path.join(workDir, 'calibration');
  const browser = await launchBrowser();
  let marks = [];
  const take = await performScene(
    browser,
    {
      id: 'calibration',
      async setup(t) {
        // Any localhost URL: the page is served by the recorder, and audio worklets need a secure origin.
        await t.page.goto('http://localhost:3000/__walkthrough/index.html');
      },
      async run(t) {
        marks = await t.page.evaluate(() => window.runCalibration());
        await t.hold(500);
      },
    },
    { dir, mode: 'record', assetsDir: path.join(import.meta.dirname, 'calibration') },
  );
  await browser.close();

  // ---- audio: where each click starts in the recorded WAV
  const audioOnsets = [];
  for (const recording of take.audio) {
    const wav = readFileSync(recording.file);
    const rate = wav.readUInt32LE(24);
    const samples = new Int16Array(wav.buffer, wav.byteOffset + 44, (wav.length - 44) / 2);
    let quietSince = -Infinity;
    for (let i = 0; i < samples.length; i += 2) {
      const loud = Math.abs(samples[i]) > 1500;
      if (loud && i / 2 - quietSince > rate * 0.3) audioOnsets.push(recording.startedAt + i / 2 / rate);
      if (loud) quietSince = i / 2;
    }
  }

  // ---- picture: the first frame of each flash (mean brightness per frame, from ffmpeg)
  const list = path.join(dir, 'frames.ffconcat');
  writeFileSync(list, ['ffconcat version 1.0', ...take.frames.map((frame) => `file '${frame.file}'\nduration 0.04`)].join('\n') + '\n');
  const stats = spawnSync(
    'ffmpeg',
    ['-hide_banner', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-vf', 'signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-', '-f', 'null', '-'],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  const brightness = [...stats.stdout.matchAll(/YAVG=([\d.]+)/g)].map((match) => Number(match[1]));
  const flashFrames = [];
  brightness.forEach((value, index) => {
    if (value > 150 && (index === 0 || brightness[index - 1] <= 150) && take.frames[index]) flashFrames.push(take.frames[index].at);
  });

  const nearest = (list, value) => list.reduce((best, item) => (Math.abs(item - value) < Math.abs(best - value) ? item : best), Infinity);
  console.log('\nclick   audio − due   frame − flash   (ms; the context is suspended before click 4)');
  const audioErrors = [];
  marks.forEach((mark, index) => {
    const audio = (nearest(audioOnsets, mark.clickDueMs / 1000) - mark.clickDueMs / 1000) * 1000;
    const frame = (nearest(flashFrames, mark.flashMs / 1000) - mark.flashMs / 1000) * 1000;
    audioErrors.push(audio);
    console.log(`  ${index + 1}     ${audio.toFixed(1).padStart(8)}       ${frame.toFixed(1).padStart(8)}`);
  });
  const sorted = [...audioErrors].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  console.log(`\nclicks found in audio: ${audioOnsets.length}/5, flashes found in frames: ${flashFrames.length}/5`);
  console.log(`median audio offset ${median.toFixed(1)} ms. To cancel it: WALKTHROUGH_AUDIO_LATENCY=${(-median / 1000).toFixed(3)}`);

  const edited = await calibrateEdit({ dir: path.join(workDir, 'calibration-edit') });
  return { marks, audioOnsets, flashFrames, edited };
}

/** The same clicks and flashes, measured in a clip that has had waits cut out of it. */
async function calibrateEdit({ dir }) {
  const browser = await launchBrowser();
  const take = await performScene(
    browser,
    {
      id: 'calibration-edit',
      async setup(t) {
        await t.page.goto('http://localhost:3000/__walkthrough/index.html');
      },
      async run(t) {
        await t.cut(() => t.hold(1700), { label: null });
        await t.page.evaluate(() => window.runCalibration());
        await t.cut(() => t.hold(2300), { label: null });
        await t.page.evaluate(() => window.runCalibration());
        await t.hold(500);
      },
    },
    { dir: path.join(dir, 'take'), mode: 'record', assetsDir: path.join(import.meta.dirname, 'calibration') },
  );
  await browser.close();
  const clip = buildSceneClip(take, path.join(dir, 'clip'));

  // Clicks in the clip's sound.
  const wav = readFileSync(clip.audio);
  const rate = wav.readUInt32LE(24);
  const data = wav.indexOf('data', 12) + 8;
  const samples = new Int16Array(wav.buffer, wav.byteOffset + data, Math.floor((wav.length - data) / 2));
  const clicks = [];
  let quietSince = -Infinity;
  for (let i = 0; i < samples.length; i += 2) {
    const loud = Math.abs(samples[i]) > 1500;
    if (loud && i / 2 - quietSince > rate * 0.3) clicks.push(i / 2 / rate);
    if (loud) quietSince = i / 2;
  }
  // Flashes in the clip's picture.
  const stats = spawnSync(
    'ffmpeg',
    ['-hide_banner', '-loglevel', 'error', '-i', clip.video, '-vf', 'signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-', '-f', 'null', '-'],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  const brightness = [...stats.stdout.matchAll(/YAVG=([\d.]+)/g)].map((match) => Number(match[1]));
  const flashes = [];
  brightness.forEach((value, index) => {
    if (value > 150 && (index === 0 || brightness[index - 1] <= 150)) flashes.push(index / 30);
  });

  console.log(`\nafter the edit (two cuts, ${take.cuts.map((cut) => (cut.end - cut.start).toFixed(1)).join(' s and ')} s): click − flash, in the built clip`);
  const errors = flashes.map((flash) => {
    const click = clicks.reduce((best, item) => (Math.abs(item - flash) < Math.abs(best - flash) ? item : best), Infinity);
    return (click - flash) * 1000;
  });
  console.log(`  ${errors.map((error) => error.toFixed(0)).join('  ')}   (ms)`);
  const worst = Math.max(...errors.map(Math.abs));
  console.log(`  clicks ${clicks.length}/10, flashes ${flashes.length}/10, worst ${worst.toFixed(0)} ms: ${clicks.length === 10 && flashes.length === 10 && worst <= 70 ? 'in step' : 'OUT OF STEP'}`);
  return { clicks, flashes, worst };
}
