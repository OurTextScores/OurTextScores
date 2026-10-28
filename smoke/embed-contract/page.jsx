'use client';
import { useState } from 'react';
import { FindingReview } from '../scanner/finding-review';
import ChangeReviewDetailClient from '../change-reviews/change-review-detail-client';
import PageComparison from '../scanner/[jobId]/page-comparison';

const finding = { kind: 'clef_profile_mismatch', part: 'cello', message: 'Cello clef', system: 0 };
const review = { reviewId: 'review-1', viewerUserId:'reviewer-1', workId:'work-1', sourceId:'source-1', baseRevisionId:'rev-1', headRevisionId:'rev-2', baseSequenceNumber:1, headSequenceNumber:2, reviewerUserId:'reviewer-1', ownerUserId:'owner-1', title:'Review', summary:'', status:'draft', unresolvedThreadCount:0, openThreadCount:0, resolvedThreadCount:0, lastActivityAt:'2026-03-07T16:00:00Z', createdAt:'2026-03-07T15:59:00Z', work:{workId:'work-1'}, source:{sourceId:'source-1'}, permissions:{canRead:true,canEditDraft:false,canAddThread:false,canSubmit:false,canClose:false,canWithdraw:false,canReply:false,canResolve:false} };
const diff = { reviewId:'review-1', fileKind:'canonical', baseRevisionId:'rev-1', headRevisionId:'rev-2', scoreRegions:[], hunks:[], threads:[] };
const page = { pageNumber:1, ordinal:1, included:true, status:'succeeded', hasMusicXml:true, engines:{ homr:{status:'succeeded',hasMusicXml:true}, transcoda:{status:'succeeded',hasMusicXml:true} } };
const job = { jobId:'job-c', statusVersion:1, originalFilename:'score.pdf', pageCount:1, pages:[page], enginePlan:{engineIds:['homr','transcoda'], primaryEngineId:'homr', capabilitySnapshots:{homr:{displayName:'HOMR'},transcoda:{displayName:'Transcoda'}}} };
export default function ContractHarness() {
  const [version, setVersion] = useState(1);
  const [second, setSecond] = useState(true);
  const [comparison, setComparison] = useState(false);
  return <main>
    <button onClick={() => setVersion(2)}>Replace first reading</button>
    <button onClick={() => setSecond(false)}>Remove second frame</button>
    <button onClick={() => setComparison(true)}>Open comparison</button>
    <div data-testid="host-a"><FindingReview jobId="job-a" pageNumber={1} engineId="homr" readingUrl={`/score-editor/test_scores/three_notes_cde.musicxml?version=${version}`} findings={[finding]} onDecide={() => {}} /></div>
    {second && <div data-testid="host-b"><FindingReview jobId="job-b" pageNumber={1} engineId="homr" readingUrl="/score-editor/test_scores/three_notes_cde.musicxml" findings={[finding]} onDecide={() => {}} /></div>}
    <div data-testid="host-review"><ChangeReviewDetailClient initialReview={review} initialDiff={diff} /></div>
    {comparison && <div data-testid="host-comparison"><PageComparison jobId="job-c" job={job} page={page} open /></div>}
  </main>;
}
