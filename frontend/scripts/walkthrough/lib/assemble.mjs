import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { CardRenderer } from './cards.mjs';
import { OUTPUT } from './recorder.mjs';

/**
 * Turns recorded takes into the finished video.
 *
 *   takes/<scene>/        frames + take.json (+ audio)     from the recorder
 *   build/<scene>/        video.mp4, audio.wav             one clip per scene, cuts applied
 *   build/master.mp4      title + scenes + end card        no captions: the clean master
 *   final/                captioned .mp4 and .webm, .srt, .vtt, chapters.txt, poster.png, script.md
 *
 * Scene audio is kept as PCM until the master is encoded, so joining scenes cannot click.
 */
const FPS = OUTPUT.fps;
/** Measured with `run.mjs <video> --calibrate`: how late the audio tap's recording starts relative to its timestamp. */
const AUDIO_LATENCY_S = Number(process.env.WALKTHROUGH_AUDIO_LATENCY ?? 0);
const VIDEO_ARGS = [
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', String(FPS), '-g', String(FPS * 2),
  '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
];
const frameAlign = (seconds) => Math.max(1, Math.round(seconds * FPS)) / FPS;

function ffmpeg(args) {
  const result = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], {
    stdio: ['ignore', 'inherit', 'pipe'],
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`ffmpeg failed (${result.status}): ${result.stderr?.slice(-1500)}\n  args: ${args.join(' ').slice(0, 600)}`);
  }
}

// ------------------------------------------------------------------------ scene timeline
/** The scene's own clock: seconds from its start, with the cut ranges removed. */
function sceneClock(take) {
  const clamp = (t) => Math.min(take.endedAt, Math.max(take.startedAt, t));
  const sorted = take.cuts
    .map((cut) => ({ start: clamp(cut.start), end: clamp(cut.end), label: cut.label }))
    .filter((cut) => cut.end - cut.start > 0.05)
    .sort((a, b) => a.start - b.start);
  const cuts = [];
  for (const cut of sorted) {
    const last = cuts.at(-1);
    if (last && cut.start <= last.end) {
      last.end = Math.max(last.end, cut.end);
      last.label ??= cut.label;
    } else {
      cuts.push({ ...cut });
    }
  }
  const removedBefore = (t) =>
    cuts.reduce((sum, cut) => sum + Math.min(Math.max(t - cut.start, 0), cut.end - cut.start), 0);
  const map = (t) => clamp(t) - take.startedAt - removedBefore(clamp(t));
  return { cuts, map, rawDuration: take.endedAt - take.startedAt, duration: frameAlign(map(take.endedAt)) };
}

function buildSceneVideo(take, clock, dir) {
  const frames = [...take.frames].sort((a, b) => a.at - b.at);
  if (frames.length === 0) throw new Error(`no frames recorded in ${dir}`);
  const shown = [];
  let before = null;
  const lastInCut = new Map();
  for (const frame of frames) {
    if (frame.at < take.startedAt) {
      before = frame;
      continue;
    }
    if (frame.at > take.endedAt) break;
    const cut = clock.cuts.find((range) => frame.at >= range.start && frame.at < range.end);
    if (cut) {
      lastInCut.set(cut, frame);
      continue;
    }
    shown.push({ at: clock.map(frame.at), file: frame.file, order: 1 });
  }
  // The screencast sends a frame only when the picture changes. So the picture at the very
  // start is the last one sent before it, and the picture after a cut is the last one drawn
  // during it; neither arrives again by itself.
  if (shown.length === 0 || shown[0].at > 0.001) shown.push({ at: 0, file: (before ?? frames[0]).file, order: 0 });
  for (const [cut, frame] of lastInCut) shown.push({ at: clock.map(cut.end), file: frame.file, order: 0 });
  shown.sort((a, b) => a.at - b.at || a.order - b.order);

  // Each frame is shown until the next one arrived. Frames come at up to 60 a second, faster
  // than the output, so these lengths must be kept exactly as they are: rounding each one up
  // to a whole output frame would stretch the picture against the sound and the captions.
  const lines = ['ffconcat version 1.0'];
  for (let i = 0; i < shown.length; i++) {
    const last = i + 1 === shown.length;
    const length = (last ? clock.duration : shown[i + 1].at) - shown[i].at;
    if (length <= 0 && !last) continue;
    lines.push(`file '${shown[i].file}'`, `duration ${Math.max(length, last ? 1 / FPS : 0).toFixed(5)}`);
  }
  lines.push(`file '${shown.at(-1).file}'`); // the concat demuxer ignores the last duration without this
  const list = path.join(dir, 'frames.ffconcat');
  writeFileSync(list, lines.join('\n') + '\n');
  ffmpeg([
    '-f', 'concat', '-safe', '0', '-i', list,
    // Screencast frames are full-range JPEG; video is limited-range BT.709.
    '-vf', `fps=${FPS},scale=${OUTPUT.width}:${OUTPUT.height}:in_range=full:in_color_matrix=bt601:out_range=tv:out_color_matrix=bt709,format=yuv420p`,
    '-frames:v', String(Math.round(clock.duration * FPS)), '-an', ...VIDEO_ARGS, '-preset', 'medium', '-crf', '12',
    path.join(dir, 'video.mp4'),
  ]);
}

function buildSceneAudio(take, clock, dir) {
  const out = path.join(dir, 'audio.wav');
  const length = clock.duration.toFixed(5);
  if (take.audio.length === 0) {
    ffmpeg(['-f', 'lavfi', '-t', length, '-i', 'anullsrc=r=48000:cl=stereo', '-c:a', 'pcm_s16le', out]);
    return;
  }
  const inputs = [];
  const chains = [];
  take.audio.forEach((recording, index) => {
    inputs.push('-i', recording.file);
    const offset = recording.startedAt + AUDIO_LATENCY_S - take.startedAt;
    const placed = offset >= 0 ? `adelay=${Math.round(offset * 1000)}:all=1` : `atrim=start=${(-offset).toFixed(4)},asetpts=PTS-STARTPTS`;
    chains.push(`[${index}:a]aresample=48000,aformat=channel_layouts=stereo,${placed}[a${index}]`);
  });
  const head =
    take.audio.length === 1
      ? '[a0]anull'
      : `${take.audio.map((_, i) => `[a${i}]`).join('')}amix=inputs=${take.audio.length}:normalize=0`;
  const raw = clock.rawDuration.toFixed(4);
  // Cuts are given in the scene's raw time, which is what `t` is here: silence-padded from the scene's start.
  const keep = clock.cuts.length
    ? `,aselect='not(${clock.cuts.map((cut) => `between(t,${(cut.start - take.startedAt).toFixed(4)},${(cut.end - take.startedAt).toFixed(4)})`).join('+')})',asetpts=N/SR/TB`
    : '';
  chains.push(`${head},apad=whole_dur=${raw},atrim=0:${raw}${keep},apad=whole_dur=${length},atrim=0:${length}[out]`);
  ffmpeg([...inputs, '-filter_complex', chains.join(';'), '-map', '[out]', '-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '2', out]);
}

function buildCardClip(png, seconds, dir) {
  mkdirSync(dir, { recursive: true });
  const length = frameAlign(seconds);
  ffmpeg([
    '-loop', '1', '-framerate', String(FPS), '-t', length.toFixed(5), '-i', png,
    '-vf', `scale=${OUTPUT.width}:${OUTPUT.height},format=yuv420p,fade=t=in:st=0:d=0.35,fade=t=out:st=${(length - 0.35).toFixed(3)}:d=0.35`,
    '-frames:v', String(Math.round(length * FPS)), '-an', ...VIDEO_ARGS, '-preset', 'medium', '-crf', '12',
    path.join(dir, 'video.mp4'),
  ]);
  ffmpeg(['-f', 'lavfi', '-t', length.toFixed(5), '-i', 'anullsrc=r=48000:cl=stereo', '-c:a', 'pcm_s16le', path.join(dir, 'audio.wav')]);
  return length;
}

// ------------------------------------------------------------------------ text outputs
const stamp = (seconds, separator) => {
  const ms = Math.round(seconds * 1000);
  const pad = (value, width = 2) => String(value).padStart(width, '0');
  return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}:${pad(Math.floor(ms / 1000) % 60)}${separator}${pad(ms % 1000, 3)}`;
};
const chapterStamp = (seconds) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds) % 60).padStart(2, '0')}`;

// ------------------------------------------------------------------------ assemble
export async function assemble(video, { workDir }) {
  const takesDir = path.join(workDir, 'takes');
  const buildDir = path.join(workDir, 'build');
  const finalDir = path.join(workDir, 'final');
  mkdirSync(buildDir, { recursive: true });
  mkdirSync(finalDir, { recursive: true });
  const cards = await CardRenderer.open();
  const segments = [];
  const captions = [];
  const overlays = [];
  const chapters = [];
  const warnings = [];
  let cursor = 0;

  try {
    // ---- title card
    if (video.titleCard) {
      const dir = path.join(buildDir, '_title');
      mkdirSync(dir, { recursive: true });
      const card = await cards.card(video.titleCard, path.join(dir, 'card.png'));
      const length = buildCardClip(card.file, video.titleCard.seconds ?? 4, dir);
      segments.push({ id: '_title', dir, start: cursor, length });
      chapters.push({ at: 0, title: video.titleCard.chapter ?? 'Intro' });
      copyFileSync(card.file, path.join(finalDir, 'poster.png'));
      cursor += length;
    }

    // ---- scenes
    for (const scene of video.scenes) {
      const takeFile = path.join(takesDir, scene.id, 'take.json');
      if (!existsSync(takeFile)) throw new Error(`scene "${scene.id}" has not been recorded (${takeFile})`);
      const take = JSON.parse(readFileSync(takeFile, 'utf8'));
      const dir = path.join(buildDir, scene.id);
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
      const clock = sceneClock(take);
      process.stdout.write(`assemble ${scene.id}: ${clock.duration.toFixed(1)}s … `);
      buildSceneVideo(take, clock, dir);
      buildSceneAudio(take, clock, dir);
      console.log('ok');
      segments.push({ id: scene.id, dir, start: cursor, length: clock.duration });
      if (scene.chapter && chapters.at(-1)?.title !== scene.chapter) chapters.push({ at: cursor, title: scene.chapter });

      take.captions.forEach((caption, index) => {
        const next = take.captions[index + 1];
        const start = clock.map(caption.start);
        // A short gap before the next caption reads as a new sentence rather than a flicker.
        const end = Math.min(clock.map(caption.end ?? take.endedAt), next ? clock.map(next.start) - 0.15 : clock.duration - 0.05);
        if (end - start < 0.4) return;
        const needed = Math.max(1.6, caption.text.length / 17);
        if (end - start < needed) {
          warnings.push(`${scene.id}: caption shown ${(end - start).toFixed(1)}s, needs about ${needed.toFixed(1)}s to read: "${caption.text.slice(0, 60)}"`);
        }
        captions.push({ scene: scene.id, text: caption.text, position: caption.position, start: cursor + start, end: cursor + end });
      });
      for (const cut of clock.cuts) {
        if (!cut.label) continue;
        const at = cursor + clock.map(cut.end);
        overlays.push({ kind: 'cut', text: cut.label, start: at, end: Math.min(at + 1.8, cursor + clock.duration) });
      }
      cursor += clock.duration;
    }

    // ---- end card
    if (video.endCard) {
      const dir = path.join(buildDir, '_end');
      mkdirSync(dir, { recursive: true });
      const card = await cards.card(video.endCard, path.join(dir, 'card.png'));
      const length = buildCardClip(card.file, video.endCard.seconds ?? 6, dir);
      segments.push({ id: '_end', dir, start: cursor, length });
      cursor += length;
    }

    // ---- overlay images
    const overlayDir = path.join(buildDir, '_overlays');
    rmSync(overlayDir, { recursive: true, force: true });
    for (const [index, caption] of captions.entries()) {
      const image = await cards.caption(caption.text, path.join(overlayDir, `caption-${index}.png`), { position: caption.position });
      overlays.push({ kind: 'caption', ...image, start: caption.start, end: caption.end });
    }
    for (const [index, overlay] of overlays.entries()) {
      if (overlay.kind !== 'cut') continue;
      Object.assign(overlay, await cards.cutLabel(overlay.text, path.join(overlayDir, `cut-${index}.png`)));
    }
  } finally {
    await cards.close();
  }

  // ---- clean master: scene clips joined, audio encoded once
  const total = cursor;
  const videoList = path.join(buildDir, 'videos.ffconcat');
  const audioList = path.join(buildDir, 'audios.ffconcat');
  writeFileSync(videoList, ['ffconcat version 1.0', ...segments.map((s) => `file '${path.join(s.dir, 'video.mp4')}'`)].join('\n') + '\n');
  writeFileSync(audioList, ['ffconcat version 1.0', ...segments.map((s) => `file '${path.join(s.dir, 'audio.wav')}'`)].join('\n') + '\n');
  const master = path.join(buildDir, 'master.mp4');
  const audioFilters = video.audioFilter ? ['-af', video.audioFilter] : [];
  process.stdout.write(`master (${total.toFixed(1)}s) … `);
  ffmpeg([
    '-f', 'concat', '-safe', '0', '-i', videoList, '-f', 'concat', '-safe', '0', '-i', audioList,
    '-map', '0:v', '-map', '1:a', '-c:v', 'copy', ...audioFilters, '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2',
    '-movflags', '+faststart', master,
  ]);
  console.log('ok');

  // ---- captioned video
  const base = video.outputName ?? video.id;
  const mp4 = path.join(finalDir, `${base}.mp4`);
  const inputs = ['-i', master];
  const filters = [];
  let previous = '0:v';
  overlays.sort((a, b) => a.start - b.start);
  overlays.forEach((overlay, index) => {
    const length = overlay.end - overlay.start;
    const fade = Math.min(0.2, length / 4);
    inputs.push('-loop', '1', '-framerate', String(FPS), '-t', length.toFixed(3), '-i', overlay.file);
    filters.push(
      `[${index + 1}:v]format=rgba,fade=t=in:st=0:d=${fade}:alpha=1,fade=t=out:st=${(length - fade).toFixed(3)}:d=${fade}:alpha=1,setpts=PTS-STARTPTS+${overlay.start.toFixed(3)}/TB[o${index}]`,
      `[${previous}][o${index}]overlay=${overlay.x}:${overlay.y}:eof_action=pass:enable='between(t,${overlay.start.toFixed(3)},${overlay.end.toFixed(3)})'[v${index}]`,
    );
    previous = `v${index}`;
  });
  process.stdout.write(`captioned mp4 (${overlays.length} overlays) … `);
  if (overlays.length === 0) {
    copyFileSync(master, mp4);
  } else {
    ffmpeg([
      ...inputs, '-filter_complex', filters.join(';'), '-map', `[${previous}]`, '-map', '0:a',
      ...VIDEO_ARGS, '-preset', 'slow', '-crf', '18', '-c:a', 'copy', '-movflags', '+faststart', mp4,
    ]);
  }
  console.log('ok');
  copyFileSync(master, path.join(finalDir, `${base}.clean.mp4`));

  if (!process.env.WALKTHROUGH_SKIP_WEBM) {
    process.stdout.write('webm … ');
    ffmpeg([
      '-i', mp4, '-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '33', '-row-mt', '1', '-cpu-used', '3', '-g', String(FPS * 4),
      '-c:a', 'libopus', '-b:a', '128k', path.join(finalDir, `${base}.webm`),
    ]);
    console.log('ok');
  }

  // ---- text outputs
  const cues = captions.map((caption, index) => ({ ...caption, index: index + 1 }));
  writeFileSync(
    path.join(finalDir, `${base}.srt`),
    cues.map((cue) => `${cue.index}\n${stamp(cue.start, ',')} --> ${stamp(cue.end, ',')}\n${cue.text}\n`).join('\n'),
  );
  writeFileSync(
    path.join(finalDir, `${base}.vtt`),
    'WEBVTT\n\n' + cues.map((cue) => `${stamp(cue.start, '.')} --> ${stamp(cue.end, '.')}\n${cue.text}\n`).join('\n'),
  );
  writeFileSync(path.join(finalDir, 'chapters.txt'), chapters.map((chapter) => `${chapterStamp(chapter.at)} ${chapter.title}`).join('\n') + '\n');
  const script = [`# ${video.title}`, '', `Length ${chapterStamp(total)}. Captions as shown, by chapter.`, ''];
  for (const [index, chapter] of chapters.entries()) {
    const until = chapters[index + 1]?.at ?? total;
    script.push(`## ${chapterStamp(chapter.at)} ${chapter.title}`, '');
    for (const cue of cues.filter((c) => c.start >= chapter.at - 0.001 && c.start < until)) script.push(`- ${cue.text}`);
    script.push('');
  }
  writeFileSync(path.join(finalDir, 'script.md'), script.join('\n'));
  writeFileSync(path.join(buildDir, 'timeline.json'), JSON.stringify({ total, segments, chapters, captions: cues, overlays, warnings }, null, 2));

  console.log(`\n${video.title}: ${chapterStamp(total)} → ${finalDir}`);
  for (const warning of warnings) console.log(`  ! ${warning}`);
  return { total, finalDir, warnings };
}
