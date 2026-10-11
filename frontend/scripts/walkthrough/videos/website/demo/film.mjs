import { DEMO } from './demo.mjs';
import { CATALOGUE, entry } from './catalogue.mjs';
import { api, REVIEW } from './seed.mjs';

/**
 * What a scene needs from the demo site before it is filmed: where the seeded things are, and
 * a way to put back what a take changes, so that the scene can be performed again.
 */
export async function workIdOf(key) {
  const work = await api('POST', '/works/save-by-url', { json: { url: entry(key).imslp } });
  return work.workId ?? work.work?.workId;
}

/** A seeded source, found by the label it was given. */
export async function sourceOf(workKey, sourceKey) {
  const workId = await workIdOf(workKey);
  const wanted = entry(workKey).sources.find((source) => source.key === sourceKey);
  const work = await api('GET', `/works/${workId}`);
  const source = work.sources.find((item) => item.label === wanted.label);
  if (!source) throw new Error(`the demo has no "${wanted.label}": run the seed`);
  return { workId, sourceId: source.sourceId, label: wanted.label, source };
}

/** Removes every source of a work that is filled on camera, leaving the work itself. */
export async function emptyWork(key) {
  const workId = await workIdOf(key);
  await api('POST', `/works/${workId}/sources/delete-all`, { as: DEMO.admin });
  return workId;
}

export async function stopWatching(person, { workId, sourceId }) {
  await api('DELETE', `/works/${workId}/sources/${sourceId}/watch`, { as: person, raw: true });
}

/** The seeded change review, and what a take may have added to it taken away again. */
export async function seededReview({ tidyFor = null } = {}) {
  const { workId, sourceId } = await sourceOf('dichterliebe', 'rose');
  const list = await api('GET', '/change-reviews?limit=50', { as: DEMO.people.clara });
  const review = (list.items ?? []).find((item) => item.sourceId === sourceId && item.branchName === REVIEW.branch);
  if (!review) throw new Error('the demo has no change review: run the seed');
  if (tidyFor) {
    const { user } = await api('GET', '/users/me', { as: tidyFor });
    const detail = await api('GET', `/change-reviews/${review.reviewId}/diff?patchset=1`, { as: tidyFor });
    for (const thread of detail.threads ?? []) {
      for (const comment of thread.comments ?? []) {
        const seeded = [REVIEW.question, REVIEW.answer].includes(comment.content);
        if (!seeded && String(comment.userId) === String(user.id)) {
          await api('DELETE', `/change-reviews/${review.reviewId}/comments/${comment.commentId}`, { as: tidyFor });
        }
      }
    }
  }
  return { workId, sourceId, reviewId: review.reviewId };
}

export { CATALOGUE, DEMO, REVIEW };
