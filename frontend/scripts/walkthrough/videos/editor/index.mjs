import path from 'node:path';

const here = import.meta.dirname;
const scene = async (name) => (await import(`./scenes/${name}.mjs`)).default;
const { aiKey } = await import('./scenes/ai.mjs');

export default {
  id: 'editor',
  title: 'OTS Web Editor',
  subtitle: 'MuseScore’s engraving engine, in your browser',
  assetsDir: path.join(here, 'assets'),
  // The editor's own output peaks around -6 dBFS; lift it a little, with a ceiling.
  audioFilter: 'volume=3dB,alimiter=limit=0.89:level=disabled',
  titleCard: {
    title: 'OTS Web Editor',
    subtitle: 'MuseScore’s engraving engine, in your browser',
    logo: path.join(here, '..', '..', '..', '..', 'public', 'images', 'OTS-icon.svg'),
    seconds: 4,
    chapter: 'OTS Web Editor',
    say: 'The O T S Web Editor: MuseScore’s engraving engine, in your browser.',
  },
  endCard: {
    title: 'Try it',
    subtitle: 'ourtextscores.com/score-editor',
    lines: ['Free and open source (GPL-3.0)', 'github.com/OurTextScores/OTS_WebEditor'],
    footer:
      'Music shown: Gabriel Fauré, String Quartet Op. 121, from OpenScore String Quartets (CC0), and the Ode to Joy theme by Ludwig van Beethoven.',
    seconds: 6,
    say: 'It is free and open source. Try it at Our Text Scores dot com.',
  },
  scenes: [
    await scene('open'),
    await scene('tour'),
    await scene('note-entry'),
    await scene('editing'),
    await scene('marks'),
    await scene('layout'),
    await scene('playback'),
    await scene('history'),
    await scene('source'),
    // A real request to the assistant when a key is available for it; a look at the panel when not.
    await scene(aiKey() ? 'ai' : 'ai-tour'),
    await scene('export'),
    ...(process.env.WALKTHROUGH_PROBE ? [await scene('probe')] : []),
  ],
};
