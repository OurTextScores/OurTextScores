const WebMscore=require('webmscore');const fs=require('fs');
(async()=>{await WebMscore.ready;const [inp,out]=process.argv.slice(2);
const score=await WebMscore.load('musicxml',fs.readFileSync(inp),[],false);
const xml=await score.saveXml();fs.writeFileSync(out,Buffer.from(xml));await score.destroy();process.exit(0)})().catch(e=>{console.error('ERR',e.message);process.exit(1)});
