import { SCORES, stage } from '../editor.mjs';

/**
 * A scratch scene for working out a new shot. It is only part of the video when
 * WALKTHROUGH_PROBE is set:
 *
 *   WALKTHROUGH_PROBE=1 node scripts/walkthrough/run.mjs editor --dry --scene probe
 *
 * Try things here, look at the screenshots in dry/probe/snaps/, then move what works into a
 * real scene.
 */
export default {
  id: 'probe',
  chapter: 'Probe',
  async setup(t) {
    await stage(t, { score: SCORES.ode });
  },
  async run(t) {
    await t.snap('start');
  },
};
