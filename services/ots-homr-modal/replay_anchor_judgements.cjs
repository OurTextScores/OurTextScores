// Development replay of frozen owner-judged placements; never replaces the fresh score.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const backend = path.resolve(__dirname, '../../backend');
const ts = require(path.join(backend, 'node_modules/typescript'));
require.extensions['.ts'] = (module, file) => module._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,file);
const {buildLyricCandidateInventory} = require(path.join(backend,'src/scanner/scanner-lyric-candidates.ts'));
const [work,keyFile,judgementFile,out] = process.argv.slice(2);
const key = JSON.parse(fs.readFileSync(keyFile));
const judgement = JSON.parse(fs.readFileSync(judgementFile));
if(key.length!==Object.keys(judgement.judgements).length||key.some(k=>!Object.hasOwn(judgement.judgements,k.id)))throw Error('Review membership differs');
const hashes={};for(const p of [keyFile,judgementFile])hashes[p]=crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');const read=p=>{const data=fs.readFileSync(p);hashes[p]=crypto.createHash('sha256').update(data).digest('hex');return JSON.parse(data);};
const results=[];const pages={};
for(const score of [...new Set(key.map(k=>k.score))]){
 const inv=read(path.join(work,`inventory-${score}.json`));const review=read(path.join(work,`review-${score}.json`));
 // Replay frozen row verdicts and OCR. New rules may only withhold existing proposals.
 const rebuilt=buildLyricCandidateInventory({fusedRegions:[],lyricText:{status:inv.ocrStatus,rows:inv.ocrRows}},inv.pageNumber,inv.raster,review.staves);
 for(const item of key.filter(k=>k.score===score)){
  const old=inv.ocrRows.find(r=>r.id===item.row);const baseline=old?.anchor?.syllables[item.syllable];if(!baseline||baseline.text!==item.text)throw Error('Frozen row evidence differs');
  const row=rebuilt.ocrRows.find(r=>r.id===item.row);
  // Match by unchanged text and x rather than ordinal: removing punctuation shifts array indices.
  const exact=(row?.anchor?.syllables||[]).filter(s=>s.text===baseline.text&&Math.abs(s.x-baseline.x)<1e-6);
  const matches=exact.length?exact:(row?.anchor?.syllables||[]).filter(s=>s.text===baseline.text);
  if(matches.length>1)throw Error('Nonunique retained syllable');
  const syllable=matches[0];const retained=!!row?.proposedLyric&&syllable?.noteTokenIndex!=null;
  const unchanged=!!syllable&&['noteTokenIndex','measureInStaff','noteOrdinalInMeasure','notePitch','noteX'].every(k=>syllable[k]===baseline[k]);
  results.push({id:item.id,score,text:item.text,judgement:judgement.judgements[item.id],retained,anchorUnchanged:unchanged,withheldReason:row?.withheldReason||(!syllable?(/[\p{L}\p{N}]/u.test(baseline.text)?'segmentation-changed':'punctuation-only'):null),positionChanged:!!syllable&&Math.abs(syllable.x-baseline.x)>1e-6});
 }
}
const correct=r=>r.judgement==='correct';const report={developmentReplay:true,sourceFreeRules:true,independentAccuracyClaim:false,items:results.length,retained:results.filter(r=>r.retained).length,retainedCorrect:results.filter(r=>r.retained&&correct(r)).length,retainedWrong:results.filter(r=>r.retained&&!correct(r)).length,removedCorrect:results.filter(r=>!r.retained&&correct(r)),removedWrong:results.filter(r=>!r.retained&&!correct(r)),changedRetainedAnchors:results.filter(r=>r.retained&&!r.anchorUnchanged),inputSha256:hashes};
for(const name of ['scanner-lyric-anchors.ts','scanner-lyric-candidates.ts']){const p=path.join(backend,'src/scanner',name);report.inputSha256[p]=crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');}
report.results=results;
fs.writeFileSync(out,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
const {results:_,inputSha256:__,...summary}=report;console.log(JSON.stringify(summary,null,2));
