import { visit } from '../site.mjs';

/**
 * A scratch scene for working out a new shot. Only part of the video when WALKTHROUGH_PROBE is set:
 *
 *   WALKTHROUGH_PROBE=1 node scripts/walkthrough/run.mjs website --dry --scene probe
 */
export default {
  id: 'probe',
  chapter: 'Probe',
  async setup(t) {
    await visit(t, '/welcome');
  },
  async run(t) {
    await t.snap('start');
  },
};
