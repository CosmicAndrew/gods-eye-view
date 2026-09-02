import { existsSync } from 'node:fs';
import puppeteer from 'puppeteer';
const arg=(f,d)=>process.argv.includes(f)?process.argv[process.argv.indexOf(f)+1]:d;
const url=arg('--url','http://localhost:4173'), auth=arg('--auth',null);
const chrome=['C:/Program Files/Google/Chrome/Application/chrome.exe'].find(p=>existsSync(p));
const b=await puppeteer.launch({headless:false,executablePath:chrome,protocolTimeout:180000,
  args:['--force-high-performance-gpu','--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream','--autoplay-policy=no-user-gesture-required','--window-size=1280,860']});
try{
  const pg=await b.newPage();
  await b.defaultBrowserContext().overridePermissions(new URL(url).origin,['microphone']);
  if(auth){const[u,...r]=auth.split(':');await pg.authenticate({username:u,password:r.join(':')});}
  await pg.evaluateOnNewDocument(()=>{window.__dc=null;window.__ev=[];const n=RTCPeerConnection.prototype.createDataChannel;RTCPeerConnection.prototype.createDataChannel=function(...a){const c=n.apply(this,a);window.__dc=c;c.addEventListener('message',e=>{try{window.__ev.push(JSON.parse(e.data));}catch{}});return c;};});
  await pg.goto(url,{waitUntil:'domcontentloaded',timeout:90000});
  await pg.waitForFunction(()=>window.__godsEyeView?.annotations,{timeout:120000,polling:1000});
  await pg.waitForSelector('#gev-voice-button',{timeout:90000});
  const anns=()=>pg.evaluate(()=>{const a=window.__godsEyeView?.annotations;return a?.count?.()??a?.list?.()?.length??0;});
  await pg.click('#gev-voice-button');
  const listening=await pg.waitForFunction(()=>document.getElementById('gev-voice-control')?.dataset?.status==='listening',{timeout:90000}).then(()=>true).catch(()=>false);
  if(!listening){console.log('RESULT: could not reach LISTENING (session/rate-limit) — unit proof stands');process.exit(2);}
  await new Promise(r=>setTimeout(r,1500));
  const dcOpen=await pg.evaluate(()=>window.__dc?.readyState==='open');
  if(!dcOpen){console.log('RESULT: data channel not open (rate-limit) — unit proof stands');process.exit(2);}
  const before=await anns();
  // Issue a command, then barge in mid-resolve via the real audio event.
  await pg.evaluate(()=>{const d=window.__dc;d.send(JSON.stringify({type:'conversation.item.create',item:{type:'message',role:'user',content:[{type:'input_text',text:'Outline the Presidio in San Francisco.'}]}}));d.send(JSON.stringify({type:'response.create'}));});
  await new Promise(r=>setTimeout(r,900));
  await pg.evaluate(()=>window.__dc?.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({type:'input_audio_buffer.speech_started'})})));
  await new Promise(r=>setTimeout(r,8000));
  const after=await anns();
  console.log('annotations before/after:',before,after);
  console.log('RESULT:', after>before?'PASS — annotation survived barge-in':'FAIL — annotation lost');
  process.exit(after>before?0:1);
}finally{await b.close();}
