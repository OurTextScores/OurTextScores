#!/usr/bin/env node
/**
 * Walkthrough videos: perform scenes in a real browser, record them, assemble the result.
 *
 *   node scripts/walkthrough/run.mjs <video> --dry      [--scene a,b]   screenshots only, fast
 *   node scripts/walkthrough/run.mjs <video> --record   [--scene a,b]   record takes
 *   node scripts/walkthrough/run.mjs <video> --assemble                 build the video from takes
 *   node scripts/walkthrough/run.mjs <video> --all                      record everything, then assemble
 *   node scripts/walkthrough/run.mjs <video> --voice                    make the narrator's clips ahead of recording
 *   node scripts/walkthrough/run.mjs <video> --voice-check              have each clip transcribed and compared
 *   node scripts/walkthrough/run.mjs <video> --calibrate                measure audio and picture timing
 *
 * Takes and output go to $WALKTHROUGH_OUT (default ~/workspace/artifacts/walkthroughs), not git.
 * See README.md.
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { launchBrowser, performScene } from './lib/recorder.mjs';
import { Narration, canSynthesize } from './lib/voice.mjs';

const here = import.meta.dirname;
const [videoId, ...flags] = process.argv.slice(2);
const has = (flag) => flags.includes(flag);
const valueOf = (flag) => (flags.includes(flag) ? flags[flags.indexOf(flag) + 1] : null);

if (!videoId || !existsSync(path.join(here, 'videos', videoId, 'index.mjs'))) {
  console.error('usage: run.mjs <video> --dry|--record|--assemble|--all [--scene a,b]');
  process.exit(2);
}

const video = (await import(pathToFileURL(path.join(here, 'videos', videoId, 'index.mjs')).href)).default;
const outRoot = process.env.WALKTHROUGH_OUT || path.join(os.homedir(), 'workspace', 'artifacts', 'walkthroughs');
const workDir = path.join(outRoot, video.id);
mkdirSync(workDir, { recursive: true });

const wanted = valueOf('--scene')?.split(',');
const scenes = wanted ? video.scenes.filter((scene) => wanted.includes(scene.id)) : video.scenes;
if (wanted && scenes.length !== wanted.length) {
  const known = video.scenes.map((scene) => scene.id).join(', ');
  console.error(`unknown scene in "${wanted.join(',')}". Scenes: ${known}`);
  process.exit(2);
}

if (has('--calibrate')) {
  const { calibrate } = await import('./lib/calibrate.mjs');
  await calibrate({ workDir });
  process.exit(0);
}

const narration = new Narration(path.join(workDir, 'voice'));

/** Every line the narrator has: the cards', and each caption of the latest take (or dry run) of each scene. */
function narratorLines() {
  const lines = [video.titleCard?.say, video.endCard?.say].filter(Boolean);
  for (const scene of video.scenes) {
    const file = ['takes', 'dry'].map((kind) => path.join(workDir, kind, scene.id, 'take.json')).find((candidate) => existsSync(candidate));
    if (!file) continue;
    for (const caption of JSON.parse(readFileSync(file, 'utf8')).captions) lines.push(caption.say ?? caption.text);
  }
  return [...new Set(lines)];
}

if (has('--voice') || has('--voice-check')) {
  const lines = narratorLines();
  if (lines.length === 0) console.log('No lines yet: run --dry first, so the scenes say what their captions are.');
  if (!canSynthesize()) console.log('OPENAI_API_KEY is not set: only clips already made are available.');
  let seconds = 0;
  for (const line of lines) {
    // --voice-check also transcribes each clip, and remakes one that dropped words.
    const checked = has('--voice-check') && canSynthesize() ? await narration.verified(line) : null;
    const clip = checked?.clip ?? (await narration.ensure(line));
    if (!clip) {
      console.log(`  (no clip)  ${line}`);
      continue;
    }
    seconds += clip.seconds;
    const verdict = !checked ? '' : !checked.complete ? 'INCOMPLETE ' : checked.same ? 'same    ' : 'differs ';
    console.log(`  ${verdict}${clip.seconds.toFixed(1)}s  ${line}${checked && !checked.same ? `\n              heard: ${checked.heard}` : ''}`);
  }
  console.log(`${lines.length} lines, ${seconds.toFixed(0)}s of speech`);
  process.exit(0);
}

const mode = has('--dry') ? 'dry' : has('--record') || has('--all') ? 'record' : null;
let failed = 0;
if (mode) {
  const browser = await launchBrowser();
  for (const scene of scenes) {
    const dir = path.join(workDir, mode === 'dry' ? 'dry' : 'takes', scene.id);
    const started = Date.now();
    process.stdout.write(`${mode === 'dry' ? 'dry-run' : 'record '}  ${scene.id} … `);
    try {
      const take = await performScene(browser, scene, {
        dir,
        mode,
        speed: Number(process.env.WALKTHROUGH_DRY_SPEED ?? 0.25),
        assetsDir: video.assetsDir,
        hooks: video.hooks,
        narration,
      });
      const length = (take.endedAt - take.startedAt).toFixed(1);
      const cut = take.cuts.reduce((sum, c) => sum + (c.end - c.start), 0).toFixed(1);
      console.log(
        `${length}s (${cut}s cut), ${take.frames.length} frames, ${take.audio.length} audio, ` +
          `${take.captions.length} captions, took ${((Date.now() - started) / 1000).toFixed(0)}s`,
      );
      for (const problem of [...new Set(take.problems)].slice(0, 6)) console.log(`    ! ${problem}`);
    } catch (error) {
      failed++;
      console.log(`FAILED\n    ${String(error.stack ?? error).split('\n').slice(0, 6).join('\n    ')}`);
      console.log(`    see ${path.join(dir, 'failure.png')}`);
    }
  }
  await browser.close();
}

if ((has('--assemble') || has('--all')) && !failed) {
  const { assemble } = await import('./lib/assemble.mjs');
  // With --scene, assemble just those scenes into a separate file: a quick look, not the video.
  await assemble(wanted ? { ...video, scenes, outputName: `${video.id}.partial` } : video, { workDir });
}
process.exit(failed ? 1 : 0);
