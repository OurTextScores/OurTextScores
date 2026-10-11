// Accept every suggested lyric, direction and dynamic on each scanner job's review page, save, and write the engine
// MusicXML before (<page>__scan.musicxml) and the reviewed copy after (<page>__reviewed.musicxml) plus the review summary.
// Usage (env needs NEXTAUTH_SECRET; the frontend on :3000 and backend on :4000 must be running):
//   node accept_all.cjs jobs.jsonl OUT_DIR skip1,skip2   with jobs.jsonl lines {image, jobId}
const {encode}=require('/home/jhlusko/workspace/OurTextScores/frontend/node_modules/next-auth/jwt');
const {chromium}=require('/home/jhlusko/workspace/OTS_Web/node_modules/playwright-core');
const fs=require('fs');const jobs=fs.readFileSync(process.argv[2],'utf8').split('\n').filter(Boolean).map(l=>JSON.parse(l));const out=process.argv[3];
const skip=new Set(process.argv[4].split(','));
(async()=>{const token=await encode({token:{email:'jhlusko@gmail.com',name:'x',sub:'x'},secret:process.env.NEXTAUTH_SECRET,maxAge:14400});
const b=await chromium.launch();const ctx=await b.newContext({viewport:{width:1100,height:900}});await ctx.addCookies([{name:'next-auth.session-token',value:token,url:'http://localhost:3000'}]);
const xml=async(id)=>(await ctx.request.get(`http://localhost:3000/api/proxy/scanner/jobs/${id}/artifacts/musicxml?page=1&engine=ots-homr`)).text();
for(const j of jobs){const name=j.image.split('/').pop().replace('.png','');if(skip.has(name))continue;
 const f=`${out}/${name}`;if(fs.existsSync(f+'__reviewed.musicxml'))continue;
 try{fs.writeFileSync(f+'__scan.musicxml',await xml(j.jobId));
 const p=await ctx.newPage();await p.goto(`http://localhost:3000/scanner/${j.jobId}/pages/1/lyric-review`,{waitUntil:'networkidle',timeout:180000});
 const acc=p.getByRole('button',{name:'Accept all suggested rows'});
 if(!(await acc.waitFor({timeout:60000}).then(()=>true).catch(()=>false))){console.log('NOSUGGESTIONS',name);fs.writeFileSync(f+'__summary.txt','none');await p.close();continue;}
 await acc.click();const open=p.getByRole('button',{name:'Add accepted lyrics and staff text to the score'});await open.waitFor();await p.waitForTimeout(1500);
 const summary=await p.getByTestId('review-summary').innerText();await open.click();
 await p.getByRole('button',{name:'Add to the score'}).click();await p.getByRole('link',{name:'View the score'}).waitFor({timeout:120000});
 fs.writeFileSync(f+'__reviewed.musicxml',await xml(j.jobId));fs.writeFileSync(f+'__summary.txt',summary);console.log('OK',name,summary.replace(/\s+/g,' ').slice(0,120));await p.close();
 }catch(e){console.log('ERR',name,e.message.slice(0,140));}}
await b.close();console.log('ALLDONE');})();
