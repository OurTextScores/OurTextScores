import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DEMO } from './demo/demo.mjs';

const here = import.meta.dirname;
const scene = async (name) => (await import(`./scenes/${name}.mjs`)).default;

/**
 * The player's sounds come from cdn.ourtextscores.com, which answers browsers on the live site
 * and on localhost:3000 only. The demo site is on another port, so its browser would be
 * refused and play in silence. The recorder fetches the same file itself, once, and hands it
 * to the page as the CDN would.
 */
const SOUNDFONT = 'https://cdn.ourtextscores.com/soundfonts/default.sf3';
async function soundfont() {
  const file = path.join(DEMO.dir, 'cache', 'default.sf3');
  if (!existsSync(file)) {
    const response = await fetch(SOUNDFONT);
    if (!response.ok) throw new Error(`could not fetch the soundfont (${response.status})`);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, Buffer.from(await response.arrayBuffer()));
  }
  return readFileSync(file);
}

export default {
  id: 'website',
  title: 'OurTextScores',
  subtitle: 'Open, collaborative, editable music scores',
  assetsDir: path.join(here, 'assets'),
  audioFilter: 'volume=3dB,alimiter=limit=0.89:level=disabled',
  titleCard: {
    title: 'OurTextScores',
    subtitle: 'Open, collaborative, editable music scores',
    logo: path.join(here, '..', '..', '..', '..', 'public', 'images', 'OTS-icon.svg'),
    seconds: 4,
    chapter: 'OurTextScores',
    say: 'Our Text Scores: open, collaborative, editable music scores.',
  },
  endCard: {
    title: 'Join in',
    subtitle: 'ourtextscores.com',
    lines: ['Free and open source', 'github.com/OurTextScores'],
    footer:
      'Recorded on a demonstration copy of the site. Scores shown are CC0 transcriptions from the OpenScore Lieder Corpus and OpenScore String Quartets.',
    seconds: 6,
    say: 'It is free and open source. Join in at Our Text Scores dot com.',
  },
  hooks: {
    async beforeScene(t) {
      const body = await soundfont();
      await t.context.route(SOUNDFONT, (route) =>
        route.fulfill({ status: 200, body, contentType: 'application/octet-stream', headers: { 'access-control-allow-origin': '*' } }),
      );
    },
  },
  scenes: [
    await scene('welcome'),
    await scene('find'),
    await scene('work'),
    ...(process.env.WALKTHROUGH_PROBE ? [await scene('probe')] : []),
  ],
};
