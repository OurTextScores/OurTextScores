import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Narration: one spoken clip per caption, made with a text-to-speech API and kept in a cache.
 *
 * A clip depends only on its words and the voice settings, so it is made once and reused by
 * every later recording and assembly. That is also what lets the recorder pace a scene: before
 * it moves on from a caption it waits until that caption's clip would have finished.
 *
 * Needs OPENAI_API_KEY (or WALKTHROUGH_TTS_KEY) only to make clips that are not cached yet.
 * Without a key, cached clips still work and missing ones are reported, not invented.
 */
const MODEL = process.env.WALKTHROUGH_VOICE_MODEL || 'gpt-4o-mini-tts';
const VOICE = process.env.WALKTHROUGH_VOICE || 'marin';
const INSTRUCTIONS =
  process.env.WALKTHROUGH_VOICE_STYLE ||
  'You are narrating a short software walkthrough video. Speak clearly and warmly, at a relaxed, even pace, like a friendly guide showing a colleague around. Read exactly the words given.';

/** Seconds of quiet kept before and after a clip, so lines do not run into each other. */
export const LEAD_IN = 0.25;
export const TAIL = 0.45;

const apiKey = () => process.env.WALKTHROUGH_TTS_KEY || process.env.OPENAI_API_KEY || '';

function probeSeconds(file) {
  const result = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8' });
  return Number(result.stdout.trim());
}

export class Narration {
  constructor(dir) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
    this.manifestFile = path.join(dir, 'manifest.json');
    this.manifest = existsSync(this.manifestFile) ? JSON.parse(readFileSync(this.manifestFile, 'utf8')) : {};
    this.missing = new Set();
  }

  key(spoken) {
    return createHash('sha1').update([MODEL, VOICE, INSTRUCTIONS, spoken].join('\n')).digest('hex').slice(0, 16);
  }

  /** The cached clip for these words, or null. */
  clip(spoken) {
    const entry = this.manifest[this.key(spoken)];
    return entry && existsSync(path.join(this.dir, entry.file)) ? { ...entry, file: path.join(this.dir, entry.file) } : null;
  }

  /**
   * How long a caption must stay up for its line to be spoken: the clip's real length when
   * there is one, otherwise a cautious estimate (a first recording made before the clips
   * exist then still leaves room for them).
   */
  secondsFor(spoken) {
    const clip = this.clip(spoken);
    const speech = clip ? clip.seconds : spoken.length / 13 + 0.4;
    return LEAD_IN + speech + TAIL;
  }

  /** Makes the clip if it is not cached. Returns it, or null when it cannot be made. */
  async ensure(spoken) {
    const cached = this.clip(spoken);
    if (cached) return cached;
    if (!apiKey()) {
      this.missing.add(spoken);
      return null;
    }
    const response = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL, voice: VOICE, input: spoken, instructions: INSTRUCTIONS, response_format: 'wav' }),
    });
    if (!response.ok) {
      // Never echo the request: it carries the key.
      throw new Error(`text-to-speech failed (${response.status}): ${(await response.text()).slice(0, 300)}`);
    }
    const id = this.key(spoken);
    const raw = path.join(this.dir, `${id}.raw.wav`);
    const file = `${id}.wav`;
    writeFileSync(raw, Buffer.from(await response.arrayBuffer()));
    // Trim the silence the service pads with, and settle on one format for mixing.
    const trim = 'silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.02';
    spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', raw, '-af', `${trim},areverse,${trim},areverse`, '-ar', '48000', '-ac', '1', '-c:a', 'pcm_s16le', path.join(this.dir, file)]);
    spawnSync('rm', ['-f', raw]);
    const seconds = probeSeconds(path.join(this.dir, file));
    if (!Number.isFinite(seconds) || seconds <= 0) throw new Error(`text-to-speech returned no audio for: ${spoken}`);
    this.manifest[id] = { file, seconds, spoken, model: MODEL, voice: VOICE };
    writeFileSync(this.manifestFile, JSON.stringify(this.manifest, null, 1));
    return { ...this.manifest[id], file: path.join(this.dir, file) };
  }

  /** Forgets a clip, so the next `ensure` makes it again. */
  forget(spoken) {
    delete this.manifest[this.key(spoken)];
    writeFileSync(this.manifestFile, JSON.stringify(this.manifest, null, 1));
  }

  /**
   * Makes sure the clip says all of its line. The speech model now and then drops a sentence,
   * which nobody would notice without listening to every clip, so each new clip is transcribed
   * and made again if words are missing. A word merely heard differently ("MusicXML" as
   * "music XML") is not a reason to redo it; that is reported for a person to judge.
   *
   * Returns { clip, heard, complete, same }.
   */
  async verified(spoken, { attempts = 3 } = {}) {
    const words = (text) => text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
    let result = null;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const clip = await this.ensure(spoken);
      if (!clip) return null;
      if (clip.heard === undefined) {
        clip.heard = await this.transcribe(clip);
        this.manifest[this.key(spoken)].heard = clip.heard;
        writeFileSync(this.manifestFile, JSON.stringify(this.manifest, null, 1));
      }
      const [want, got] = [words(spoken), words(clip.heard)];
      // Length in letters, not words: a transcriber writes "ourtextscores.com" as one word
      // where the line had five, and that is not a dropped sentence.
      result = { clip, heard: clip.heard, same: want.join(' ') === got.join(' '), complete: got.join('').length >= want.join('').length * 0.8 };
      if (result.complete) break;
      if (attempt < attempts) this.forget(spoken);
    }
    return result;
  }

  /**
   * Has the service transcribe a clip, to catch a mispronounced or dropped word without anyone
   * having to listen. Returns the words heard.
   */
  async transcribe(clip) {
    const form = new FormData();
    form.append('model', process.env.WALKTHROUGH_TRANSCRIBE_MODEL || 'gpt-4o-mini-transcribe');
    form.append('file', new Blob([readFileSync(clip.file)], { type: 'audio/wav' }), 'clip.wav');
    const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey()}` },
      body: form,
    });
    if (!response.ok) throw new Error(`transcription failed (${response.status})`);
    return (await response.json()).text;
  }
}

export const voiceSettings = () => ({ model: MODEL, voice: VOICE });
export const canSynthesize = () => Boolean(apiKey());
