import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { launchBrowser, performScene } from './recorder.mjs';

/**
 * Measures the recorder against itself: a page plays five clicks, each with a full-screen
 * flash, and suspends its audio context part-way (as the editor does between sounds). Each
 * click and flash is then looked for in the recorded audio and frames.
 *
 * Prints how far the recorded sound and picture are from when the page made them. Both should
 * be within about one frame (33 ms); the audio figure is what WALKTHROUGH_AUDIO_LATENCY corrects.
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
  return { marks, audioOnsets, flashFrames };
}
