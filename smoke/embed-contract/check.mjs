import { chromium, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
const xml = await readFile(new URL('../../frontend/public/score-editor/test_scores/three_notes_cde.musicxml', import.meta.url));
const baseUrl = process.env.EMBED_CONTRACT_BASE_URL;
if (!baseUrl) throw new Error('EMBED_CONTRACT_BASE_URL is required; use npm run smoke:embed-contract');
const review = {reviewId:'review-1',viewerUserId:'reviewer-1',workId:'work-1',sourceId:'source-1',baseRevisionId:'rev-1',headRevisionId:'rev-2',baseSequenceNumber:1,headSequenceNumber:2,reviewerUserId:'reviewer-1',ownerUserId:'owner-1',title:'Review',summary:'',status:'draft',unresolvedThreadCount:0,openThreadCount:0,resolvedThreadCount:0,lastActivityAt:'2026-03-07T16:00:00Z',createdAt:'2026-03-07T15:59:00Z',work:{workId:'work-1'},source:{sourceId:'source-1'},permissions:{canRead:true,canEditDraft:false,canAddThread:false,canSubmit:false,canClose:false,canWithdraw:false,canReply:false,canResolve:false}};
const diff = {reviewId:'review-1',fileKind:'canonical',baseRevisionId:'rev-1',headRevisionId:'rev-2',scoreRegions:[],hunks:[],threads:[]};
const findingRegions = {systems:[],regions:[],findings:[{kind:'clef_profile_mismatch',part:'cello',message:'Cello clef',system:0},{kind:'dangling_slur_start',part:null,message:'Open slur',system:0}],merged:null};
const compareRegions = {version:'scanner-compare-regions-v1',analysisStatus:'succeeded',status:'ready',statusVersion:1,left:{engineId:'homr',displayName:'HOMR'},right:{engineId:'transcoda',displayName:'Transcoda'},merged:null,systems:[{systemIndex:0,leftMeasureIndexes:[0],rightMeasureIndexes:[0]}],regions:[{blockIndex:0,leftMeasureIndexes:[0],rightMeasureIndexes:[0],differenceClasses:['notation'],grounded:true,contentSignature:'scanner-block-content-v2:a',componentDifferences:[]}],warnings:[],refusalReasons:[]};
const comparison = {statusVersion:1,status:'ready',base:{engineId:'homr',displayName:'HOMR',artifactChecksumSha256:'a',unsupportedSemanticClasses:[]},candidate:{engineId:'transcoda',displayName:'Transcoda',artifactChecksumSha256:'b',unsupportedSemanticClasses:[]},refusalReasons:[],geometry:{status:'ready',geometrySignature:'scanner-measure-geometry-v1:b',refusalReasons:[],blocks:[{status:'ready',block:{blockIndex:0,stablePartKey:'p1',baseMeasureRefs:[{measureIndex:0}],candidateMeasureRefs:[{measureIndex:0}],differenceClasses:['notation'],completenessWarnings:[],contentSignature:'scanner-block-content-v2:a'}}]}};
const browser = await chromium.launch({headless:true});
const page = await browser.newPage({viewport:{width:1440,height:900}});
let hostRefresh = 0;
try {
  await page.route('**/*.{sf2,sf3}', route => route.fulfill({ status: 404 }));
  await page.route('**/api/analytics/events', route => route.fulfill({ status: 204 }));
  await page.route('**/api/score-editor/**', route => route.fulfill({ status: 503, json: { error: 'not available in contract fixture' } }));
  await page.route('**/api/proxy/**', async route => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const fromHost = route.request().frame() === page.mainFrame();
    if (fromHost && path.startsWith('/api/proxy/change-reviews/review-1')) hostRefresh++;
    if (path.includes('/findings/regions')) return route.fulfill({json:findingRegions});
    if (path.endsWith('/comparison/regions')) return route.fulfill({json:compareRegions});
    if (path.endsWith('/comparison')) return route.fulfill({json:comparison});
    if (path.includes('/comparison/readings/') || path.endsWith('/canonical.xml')) return route.fulfill({body:xml,contentType:'application/vnd.recordare.musicxml+xml'});
    if (path.endsWith('/diff')) return route.fulfill({json:diff});
    if (path.endsWith('/change-reviews/review-1')) return route.fulfill({json:review});
    return route.fulfill({status:404,json:{error:'fixture unavailable'}});
  });
  await page.goto(`${baseUrl}/contract-harness`, {waitUntil:'domcontentloaded',timeout:120000});
  const a = page.getByTestId('host-a'), b = page.getByTestId('host-b'), rev = page.getByTestId('host-review');
  const frameA = a.getByTestId('finding-review-embed').contentFrame();
  const frameB = b.getByTestId('finding-review-embed').contentFrame();
  await expect(frameA.getByTestId('finding-rows')).toBeVisible({timeout:120000});
  await expect(frameB.getByTestId('finding-rows')).toBeVisible({timeout:120000});
  await expect(a.getByTestId('finding-review-decision')).toContainText('cello', {timeout:30000});
  await expect(b.getByTestId('finding-review-decision')).toContainText('cello', {timeout:30000});
  await frameB.getByTestId('finding-rows-next').click();
  await expect(b.getByTestId('finding-review-decision')).toContainText('slur', {timeout:30000});
  await expect(a.getByTestId('finding-review-decision')).toContainText('cello');
  // A real sibling iframe sends a same-origin finding and height; A must not accept either.
  const before = await a.getByTestId('finding-review-embed').evaluate(el => el.style.height);
  await frameB.locator('body').evaluate(() => {
    window.parent.postMessage({type:'ots-finding-issue',kind:'intruder',part:null,message:'forged',index:0,total:1,places:1}, location.origin);
    window.parent.postMessage({type:'ots-compare-height',height:9999}, location.origin);
    window.parent.postMessage({type:'ots.change-review.updated',reviewId:'review-1'}, location.origin);
  });
  await page.waitForTimeout(400);
  await expect(a.getByTestId('finding-review-decision')).toContainText('cello');
  // Even the current frame's source is rejected when the message origin is wrong.
  await a.getByTestId('finding-review-embed').evaluate(frame => {
    window.dispatchEvent(new MessageEvent('message', {
      source: frame.contentWindow, origin: 'https://attacker.example',
      data: {type:'ots-finding-issue',kind:'intruder',part:null,message:'forged',index:0,total:1,places:1},
    }));
  });
  await expect(a.getByTestId('finding-review-decision')).toContainText('cello');
  await expect(a.getByTestId('finding-review-embed')).not.toHaveCSS('height','9999px');
  if (hostRefresh !== 0) throw new Error(`review unexpectedly refreshed from sibling (${hostRefresh})`);
  console.log('two live finding frames: real messages isolated; sibling spoof rejected; previous height=' + before);
  // Real review frame sends an update; only its host performs the two refresh requests.
  const reviewFrame = rev.locator('iframe').contentFrame();
  await expect(reviewFrame.locator('svg').first()).toBeVisible({timeout:120000});
  await reviewFrame.locator('body').evaluate(() => window.parent.postMessage({type:'ots.change-review.updated',reviewId:'review-1'}, location.origin));
  await expect.poll(() => hostRefresh,{timeout:30000}).toBe(2);
  console.log('review iframe update accepted; wrong sibling rejected');
  // Prevent the replacement from loading until stale controls have disappeared.
  let release; const hold = new Promise(resolve => { release = resolve; });
  await page.route('**/three_notes_cde.musicxml?version=2', async route => { await hold; await route.fulfill({body:xml,contentType:'application/vnd.recordare.musicxml+xml'}); });
  await page.getByRole('button',{name:'Replace first reading'}).click();
  await expect(a.getByTestId('finding-review-decision')).toHaveCount(0);
  release();
  await expect(a.getByTestId('finding-review-decision')).toContainText('cello',{timeout:120000});
  await page.getByRole('button',{name:'Remove second frame'}).click();
  await expect(b).toHaveCount(0);
  console.log('reading replacement cleared stale decision and reloaded; second frame removed');
  await page.getByRole('button',{name:'Open comparison'}).click();
  const comparisonHost = page.getByTestId('host-comparison');
  const comparisonFrame = comparisonHost.locator('iframe').contentFrame();
  await expect(comparisonFrame.getByTestId('system-row-header').first()).toBeVisible({timeout:120000});
  const initialHeight = await comparisonHost.locator('iframe').evaluate(el => el.style.height);
  await frameA.locator('body').evaluate(() => window.parent.postMessage({type:'ots-compare-height',height:9999},location.origin));
  await page.waitForTimeout(300);
  await expect(comparisonHost.locator('iframe')).not.toHaveCSS('height','9999px');
  console.log('live comparison frame rendered and ignored sibling height; height=' + initialHeight);
} catch (error) {
  console.error('URL:',page.url());
  if (process.env.EMBED_CONTRACT_SCREENSHOT) await page.screenshot({path:process.env.EMBED_CONTRACT_SCREENSHOT,fullPage:true}).catch(()=>{});
  console.error((await page.locator('body').innerText().catch(()=>'' )).slice(0,3500));
  throw error;
} finally { await browser.close(); }
