import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { readFile, mkdir } from 'node:fs/promises';
import { panelPage } from './production/panel.ts';

test('production panel: login, private account status, keys, logout and mobile layout',async()=> {
  const browser=await chromium.launch();
  try {
    const page=await browser.newPage({viewport:{width:1280,height:1000}}), errors:string[]=[];
    page.on('pageerror',error=>errors.push(error.message));
    let loggedIn=false, account='authenticated', qwen='not_initialized', qwenLogin=false;
    const actions: string[]=[];
    const script=await readFile(new URL('../public/panel.js',import.meta.url),'utf8');
    await page.route('https://proxy.test/**',async route=> {
      const request=route.request(), path=new URL(request.url()).pathname;
      const json=(body:unknown,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
      if(path==='/') return route.fulfill({contentType:'text/html',body:panelPage,headers:{'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'"}});
      if(path==='/assets/panel.js') return route.fulfill({contentType:'text/javascript',body:script});
      if(path==='/novnc/core/rfb.js') return route.fulfill({contentType:'text/javascript',body:'export default class RFB extends EventTarget { constructor(target) { super(); target.textContent = "Login de demonstração"; } disconnect() {} }'});
      if(path==='/api/auth/state') return json({setupRequired:false});
      if(path==='/api/auth/login') {loggedIn=true;return json({csrf:'csrf-test'});}
      if(path==='/api/auth/logout') {loggedIn=false;return json({ok:true});}
      if(!loggedIn) return json({error:{message:'Entre no painel.'}},401);
      if(path==='/api/me') return json({id:'alice',email:'alice@example.com',role:'user',csrf:'csrf-test'});
      if(path==='/api/me/accounts') return json({accounts:[
        {id:'ds',provider:'deepseek',name:'DeepSeek',accountState:account,runtimeState:'running',sessionSaved:true,checkedAt:'2026-11-03T22:00:00Z',models:['deepseek-v4-flash']},
        {id:'qw',provider:'qwen',name:'Qwen',accountState:qwen,runtimeState:qwenLogin?'running':'sleeping',sessionSaved:qwen==='authenticated',loginActive:qwenLogin,models:qwen==='authenticated'?['qwen/test-model']:[]}
      ]});
      if(path==='/api/me/accounts/qwen/connection/connect') { actions.push(path); qwenLogin=true; return json({operationId:'operation'}); }
      if(path==='/api/me/accounts/qwen/remote-ticket') return json({ticket:'qwen-ticket'});
      if(path==='/api/me/operations/operation') return json({status:'done'});
      if(path==='/api/me/status') return json({state:account,accountState:account,runtimeState:'running',sessionSaved:true,checkedAt:'2026-11-03T22:00:00Z',busy:false,queueDepth:0});
      if(path==='/api/me/keys') return request.method()==='POST'?json({id:'key',key:'dsp_one-time-secret'}):json({keys:[{id:'key',name:'Zed pessoal',prefix:'dsp_ident',revoked_at:null}]});
      return json({error:{message:'Not found'}},404);
    });
    await page.goto('https://proxy.test/');
    await page.locator('#email').fill('alice@example.com'); await page.locator('#password').fill('a-long-user-password');
    await page.locator('#auth-submit').click(); await page.locator('#dashboard').waitFor({state:'visible'});
    await page.locator('[data-provider=deepseek] [data-field=state]').filter({hasText:'Conectada'}).waitFor();
    assert.match(await page.title(),/Proxy IA/);
    assert.equal(await page.locator('.account-row').count(),2);
    assert.equal(await page.locator('[data-provider=qwen] [data-field=state]').textContent(),'Ainda não conectada');
    assert.equal(await page.locator('#administration').isVisible(),false);
    assert.match(await page.locator('[data-provider=deepseek]').textContent() || '',/Sessão salva na VPS/);
    assert.equal(await page.locator('#api-base').textContent(),'https://proxy.test/v1');
    // Load the remote viewer module used by the provider-specific login.
    assert.equal(await page.evaluate(async path=>typeof (await import(path)).default,'/novnc/core/rfb.js'),'function');
    await page.locator('#key-name').fill('Zed pessoal'); await page.locator('#key-create').click();
    await page.locator('#new-key').waitFor({state:'visible'}); assert.equal(await page.locator('#key-secret').textContent(),'dsp_one-time-secret');
    await page.locator('[data-provider=qwen]').getByRole('button',{name:'Conectar',exact:true}).click();
    await page.locator('#remote-panel').waitFor({state:'visible'});
    assert.equal(await page.locator('#remote-title').textContent(),'Entre no Qwen');
    assert.deepEqual(actions,['/api/me/accounts/qwen/connection/connect']);
    assert.equal(await page.locator('[data-provider=deepseek] [data-field=state]').textContent(),'Conectada');
    qwen='authenticated'; qwenLogin=false; await page.locator('#refresh').click();
    await page.locator('#remote-panel').waitFor({state:'hidden'});
    assert.match(await page.locator('#available-models').textContent() || '',/qwen\/test-model/);
    await mkdir('.cache',{recursive:true}); await page.screenshot({path:'.cache/production-desktop.png',fullPage:true});
    account='suspended'; await page.locator('#refresh').click();
    await page.locator('[data-provider=deepseek] [data-field=state]').filter({hasText:'Suspensa pelo provedor'}).waitFor();
    await page.setViewportSize({width:390,height:844});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
    await page.screenshot({path:'.cache/production-mobile.png',fullPage:true});
    await page.locator('#logout').click(); await page.locator('#authentication').waitFor({state:'visible'});
    assert.equal(await page.locator('#key-secret').textContent(),'');
    assert.equal(await page.locator('#new-key').isVisible(),false); assert.deepEqual(errors,[]);
  } finally { await browser.close(); }
});
