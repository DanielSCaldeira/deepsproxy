import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { chromium } from 'playwright';
import { interactiveWorkerArguments, closeInteractiveWindow } from './services/interactive-browser.ts';
import { initPlaywright, getActivePage, closePlaywright } from './services/playwright.ts';
import { createSessionStore } from './services/session-store.ts';

test('Linux worker: a human browser profile survives API handoff, stale snapshots and restart', {skip:process.platform!=='linux'||!existsSync('/usr/bin/Xvfb'),timeout:60_000}, async()=> {
  const profile=await fs.mkdtemp(path.join(os.tmpdir(),'proxy-ia-human-profile-'));
  const previous=process.env.PROVIDER_PROFILE_DIR;
  const previousDisplay=process.env.DISPLAY;
  process.env.PROVIDER_PROFILE_DIR=profile;
  let loaded:()=>void;
  let cookieSent=false;
  const ready=new Promise<void>(resolve=>{loaded=resolve;});
  const server=createServer((req,res)=>{
    if(req.url==='/ready'){cookieSent=/fixture=remembered/.test(req.headers.cookie||'');loaded();res.end('ok');return;}
    res.setHeader('Content-Type','text/html');
    res.end(`<script>localStorage.setItem('fixture-session','new-human-login');document.cookie='fixture=remembered;Max-Age=3600;Path=/';fetch('/ready')</script>`);
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  // Use the same headed browser as the worker, on a private virtual display.
  const display=spawn('Xvfb',['-displayfd','3','-screen','0','1280x900x24','-nolisten','tcp'],{stdio:['ignore','ignore','ignore','pipe']});
  let human:ChildProcess|undefined;
  const stop=async(child:ChildProcess|undefined)=>{
    if(!child || child.exitCode!==null || child.signalCode!==null)return;
    const closed=new Promise<void>(resolve=>child.once('close',()=>resolve()));
    if(child===human) await closeInteractiveWindow(child.pid!); else child.kill('SIGTERM');
    await closed;
  };
  // Only this owned fixture omits the worker proxy and sandbox namespace.
  const args=interactiveWorkerArguments(profile).filter(arg=>!arg.startsWith('--proxy-')&&!arg.startsWith('https://'));
  let timer:ReturnType<typeof setTimeout>|undefined;
  try {
    process.env.DISPLAY=await new Promise<string>((resolve,reject)=>{
      timer=setTimeout(()=>reject(new Error('Virtual display did not start')),5000);
      display.once('error',reject);
      display.stdio[3]!.once('data',chunk=>resolve(':'+String(chunk).trim()));
    });
    clearTimeout(timer);
    human=spawn(chromium.executablePath(),[...args,'--no-sandbox',origin],{stdio:'ignore'});
    await Promise.race([ready,new Promise<never>((_,reject)=>{
      timer=setTimeout(()=>reject(new Error('Owned human-browser fixture did not load')),15000);
      human!.once('error',reject);
    })]);
    clearTimeout(timer);
    assert.equal(cookieSent,true,'the fixture cookie must reach the browser before closing its window');
    await stop(human);
    await fs.writeFile(path.join(profile,'.auth-state.json'),JSON.stringify({cookies:[],origins:[{origin,localStorage:[{name:'fixture-session',value:'old-snapshot'}]}]}));
    await createSessionStore(profile).beginInteractiveLogin();
    for(let restart=0;restart<2;restart++) {
      // Default startup must also handle a worker restart during handoff.
      await initPlaywright(false);
      const page=getActivePage()!;
      await page.route(origin+'/**',route=>route.fulfill({contentType:'text/html',body:'<title>Owned session fixture</title>'}));
      await page.goto(origin);
      assert.equal(await page.evaluate(()=>localStorage.getItem('fixture-session')),'new-human-login');
      assert.match(await page.evaluate(()=>document.cookie),/fixture=remembered/);
      await createSessionStore(profile).saveSession(page.context());
      await assert.rejects(fs.access(path.join(profile,'.interactive-login.pending')),{code:'ENOENT'});
      await closePlaywright();
      await assert.rejects(fs.access(path.join(profile,'.runtime.lock')),{code:'ENOENT'});
    }
  } finally {
    clearTimeout(timer);
    await stop(human);
    await closePlaywright();
    await stop(display);
    server.closeAllConnections();
    await new Promise<void>(resolve=>server.close(()=>resolve()));
    if(previous===undefined) delete process.env.PROVIDER_PROFILE_DIR; else process.env.PROVIDER_PROFILE_DIR=previous;
    if(previousDisplay===undefined) delete process.env.DISPLAY; else process.env.DISPLAY=previousDisplay;
    await fs.rm(profile,{recursive:true,force:true});
  }
});
