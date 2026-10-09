// Compare reviewed-text geometry with cached runtime anchors; never write score XML.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const backend = path.resolve(__dirname, '../../backend');
const ts = require(path.join(backend, 'node_modules/typescript'));
require.extensions['.ts'] = (module, file) => module._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,file);
const {anchorRows} = require(path.join(backend,'src/scanner/scanner-lyric-anchors.ts'));
const [base,out] = process.argv.slice(2);
const hashes={};
const read=p=>{const bytes=fs.readFileSync(p);hashes[p]=crypto.createHash('sha256').update(bytes).digest('hex');return JSON.parse(bytes);};
const report=read(path.join(base,'lyric-corrected-crop-geometry-wide-20261008/report.json'));
const ink=read(path.join(base,'lyric-corrected-crop-geometry-wide-20261008/du-word-ink-report.json'));
const detected=read(path.join(base,'lyric-da-noteheads-20261008-v2/sequence-report.json'));
const keys=read(path.join(base,'guarded-tuplet-20261004/review/lyric-anchor-judgement-2-20261008-key.json'));
const cases=[];
for(const item of report.cases){
 const old=keys.find(x=>x.id===item.correction.id);
 const inv=read(path.join(base,`lyric-fresh2-upload-audit-20261008/saved-fresh2-inputs/inventory-${old.score}.json`));
 const review=read(path.join(base,`lyric-fresh2-upload-audit-20261008/saved-fresh2-inputs/review-${old.score}.json`));
 const row=inv.ocrRows.find(r=>r.id===old.row);let center=item.candidateCenterRaster;let method='literal CTC characters, stable across two wider crop paddings';
 if(!center&&item.correction.correctedText==='du'){
  if(row.text!==item.correction.originalText||ink.components.length!==1||!detected.firstNoteUnambiguouslyAssociated)throw Error('Word region or note association ambiguous');
  center=ink.components[0].center;method='explicitly reviewed single-word row, fresh connected-ink region; OCR still misreads du';
 }
 if(!center){cases.push({id:old.id,status:'unresolved'});continue;}
 const staff=review.staves.find(s=>s.index===old.staffIndex);
 const routed=anchorRows([{id:old.id,text:item.correction.correctedText,box:[center[0]-1,row.box[1],center[0]+1,row.box[3]]}],[staff]).get(old.id);
 const proposal=routed?.syllables[0];
 const original=row.anchor.syllables[old.syllable];
 const detectedX=item.correction.correctedText==='du'?detected.firstNoteDetectedX:null;
 cases.push({id:old.id,score:old.score,originalText:item.correction.originalText,reviewedText:item.correction.correctedText,centerRaster:center,geometryMethod:method,
  originalNote:{measure:original.measureInStaff,ordinal:original.noteOrdinalInMeasure,pitch:original.notePitch},
  candidateNote:proposal?{measure:proposal.measureInStaff,ordinal:proposal.noteOrdinalInMeasure,pitch:proposal.notePitch}:null,
  sameNoteIdentity:!!proposal&&proposal.measureInStaff===original.measureInStaff&&proposal.noteOrdinalInMeasure===original.noteOrdinalInMeasure&&proposal.notePitch===original.notePitch,
  detectedNoteX:detectedX,notePlacementConfirmed:false,automaticAttachment:false,
  scope:'Keeps frozen staff route; cached attention-based nearest note is diagnostic, not fresh notehead qualification',proposal});
}
const result={cases,inputSha256:hashes,automaticAttachment:false,musicXmlModified:false,scope:'Development comparison of explicit corrected text geometry against cached note anchors. No reference lyrics passed to OCR. Single-word ink fallback is distinct from successful OCR.'};
fs.writeFileSync(out,JSON.stringify(result,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify(cases.map(({proposal,...r})=>r),null,2));
