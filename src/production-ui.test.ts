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
    let loggedIn=false, account='authenticated', qwen='not_initialized', qwenLogin=false, deepseekLogin=false, finishAttempts=0, restricted=false;
    const providerMessage = 'Sua conta está bloqueada até novembro 6, 2026 21:55. <img src=x onerror=alert(1)>';
    let chatgpt = 'not_initialized', chatgptLogin = false, chatgptFinishAttempts = 0;
    let chatgptManual: boolean | undefined;
    let staleAccountRefresh: (() => Promise<void>) | undefined;
    let holdAccountRefresh = false;
    const actions: string[]=[];
    const script=await readFile(new URL('../public/panel.js',import.meta.url),'utf8');
    await page.route('https://proxy.test/**',async route=> {
      const request=route.request(), path=new URL(request.url()).pathname;
      const json=(body:unknown,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
      if(path==='/') return route.fulfill({contentType:'text/html',body:panelPage,headers:{'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'"}});
      if(path==='/assets/panel.js') return route.fulfill({contentType:'text/javascript',body:script});
      if(path==='/novnc/core/rfb.js') return route.fulfill({contentType:'text/javascript',body:`export default class RFB extends EventTarget {
        static current;
        constructor(target) {
          super(); RFB.current = this;
          const screen = document.createElement('div');
          screen.style.cssText = 'width:100%;height:100%;overflow:auto;display:flex';
          const canvas = document.createElement('canvas'); canvas.width = 1280; canvas.height = 900;
          canvas.style.cssText = 'flex-shrink:0;margin:auto';
          const context = canvas.getContext('2d');
          context.fillStyle = '#fff'; context.fillRect(0,0,1280,900);
          context.fillStyle = '#17232d'; context.font = '24px sans-serif';
          context.fillText('Login de demonstração',80,100);
          screen.append(canvas); target.append(screen);
        }
        disconnect() {}
      }`});
      if(path==='/api/auth/state') return json({setupRequired:false});
      if(path==='/api/auth/login') {loggedIn=true;return json({csrf:'csrf-test'});}
      if(path==='/api/auth/logout') {loggedIn=false;return json({ok:true});}
      if(!loggedIn) return json({error:{message:'Entre no painel.'}},401);
      if(path==='/api/me') return json({id:'alice',email:'alice@example.com',role:'user',csrf:'csrf-test'});
      if(path==='/api/me/accounts') {
        const snapshot = {accounts:[
        {id:'ds',provider:'deepseek',manualLoginConfirmation:true,name:'DeepSeek',accountState:account,authenticated:restricted||account==='authenticated',originalMessage:restricted?providerMessage:null,suspendedUntil:restricted?'novembro 6, 2026 21:55':null,runtimeState:'running',sessionSaved:true,loginActive:deepseekLogin,checkedAt:'2026-11-03T22:00:00Z',models:['deepseek-v4-flash']},
        {id:'qw',provider:'qwen',name:'Qwen',accountState:qwen,runtimeState:qwenLogin?'running':'sleeping',sessionSaved:qwen==='authenticated',loginActive:qwenLogin,models:qwen==='authenticated'?['qwen/test-model']:[]},
        {id:'cg',provider:'chatgpt',name:'ChatGPT',manualLoginConfirmation:chatgptManual,accountState:chatgpt,authenticated:chatgpt==='rate_limited',sessionSaved:chatgpt==='rate_limited',runtimeState:'running',loginActive:chatgptLogin,nextAllowedAt:'2026-11-06T00:00:00Z',models:[]},
        {id:'gm',provider:'gemini',name:'Gemini',accountState:'login_required',authenticated:false,sessionSaved:false,runtimeState:'running',loginActive:true,models:[]}
      ]};
        if (holdAccountRefresh) {
          holdAccountRefresh = false;
          await new Promise<void>(resolve => { staleAccountRefresh = async () => { await json(snapshot); resolve(); }; });
          return;
        }
        return json(snapshot);
      }
      if(path==='/api/me/accounts/qwen/connection/connect') { actions.push(path); qwenLogin=true; return json({operationId:'operation'}); }
      if(path==='/api/me/accounts/qwen/remote-ticket') return json({ticket:'qwen-ticket'});
      if(path==='/api/me/accounts/qwen/connection/cancel') return json({ok:true});
      if(path==='/api/me/accounts/deepseek/connection/cancel') return json({ok:true});
      if(path==='/api/me/accounts/chatgpt/connection/connect') { chatgptLogin=true; return json({operationId:'operation'}); }
      if(path==='/api/me/accounts/chatgpt/remote-ticket') return json({ticket:'chatgpt-ticket'});
      if(path==='/api/me/accounts/chatgpt/connection/finish') { chatgptFinishAttempts++; return json({operationId:'chatgpt-finish'}); }
      if(path==='/api/me/operations/chatgpt-finish') {
        if (chatgptFinishAttempts === 1) return json({status:'failed',error:'Conclua o acesso ao ChatGPT e tente novamente.'});
        chatgptLogin=false; chatgpt='rate_limited';
        await json({status:'done'});
        await staleAccountRefresh?.();
        return;
      }
      if(path==='/api/me/accounts/deepseek/connection/connect') { deepseekLogin=true; account='login_required'; return json({operationId:'operation'}); }
      if(path==='/api/me/accounts/deepseek/remote-ticket') return json({ticket:'deepseek-ticket'});
      if(path==='/api/me/accounts/deepseek/connection/finish') { finishAttempts++; return json({operationId:'finish'}); }
      if(path==='/api/me/operations/finish') {
        if(finishAttempts===1) return json({status:'failed',error:'Conclua o login antes de confirmar.'});
        deepseekLogin=false; account=restricted?'suspended':'authenticated'; return json({status:'done'});
      }
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
    assert.equal(await page.locator('.account-row').count(),4);
    // Google sign-in is confirmed manually even when an older snapshot lacks the capability.
    assert.equal(await page.locator('[data-provider=gemini]').getByRole('button',{name:'Concluir login',exact:true}).isVisible(),true);
    assert.equal(await page.locator('[data-provider=gemini]').getByRole('button',{name:'Abrir login',exact:true}).isVisible(),true);
    assert.equal(await page.locator('[data-provider=qwen] [data-field=state]').textContent(),'Ainda não conectada');
    assert.equal(await page.locator('#administration').isVisible(),false);
    assert.match(await page.locator('[data-provider=deepseek]').textContent() || '',/Sessão salva/);
    assert.equal(await page.locator('#api-base').textContent(),'https://proxy.test/v1');
    // Load the remote viewer module used by the provider-specific login.
    assert.equal(await page.evaluate(async path=>typeof (await import(path)).default,'/novnc/core/rfb.js'),'function');
    await page.locator('#key-name').fill('Zed pessoal'); await page.locator('#key-create').click();
    await page.locator('#new-key').waitFor({state:'visible'}); assert.equal(await page.locator('#key-secret').textContent(),'dsp_one-time-secret');
    await page.locator('[data-provider=qwen]').getByRole('button',{name:'Conectar',exact:true}).click();
    await page.locator('#remote-panel').waitFor({state:'visible'});
    assert.equal(await page.locator('#remote-title').textContent(),'Entre no Qwen');
    assert.equal(await page.locator('#remote-finish').isVisible(),false);
    assert.deepEqual(await page.locator('#remote-panel').boundingBox(),{x:0,y:0,width:1280,height:1000});
    assert.equal(await page.evaluate(async path => (await import(path)).default.current.scaleViewport, '/novnc/core/rfb.js'),false);
    assert.equal((await page.locator('#remote canvas').boundingBox())?.width,1280,'native-size login must remain readable without shrinking');
    await page.locator('#remote-fit').click();
    assert.equal(await page.evaluate(async path => (await import(path)).default.current.scaleViewport, '/novnc/core/rfb.js'),true);
    await page.getByRole('button',{name:'Tamanho real (100%)',exact:true}).click();
    assert.equal(await page.evaluate(async path => (await import(path)).default.current.scaleViewport, '/novnc/core/rfb.js'),false);
    await mkdir('.cache',{recursive:true});
    await page.screenshot({path:'.cache/production-login-desktop.png'});
    await page.setViewportSize({width:390,height:844});
    assert.deepEqual(await page.locator('#remote-panel').boundingBox(),{x:0,y:0,width:390,height:844});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
    const scrolled = await page.locator('#remote > div').evaluate(screen => {
      screen.scrollLeft = 500; screen.scrollTop = 200;
      return screen.scrollLeft > 0 && screen.scrollTop > 0;
    });
    assert.equal(scrolled,true,'small screens must be able to scroll the full-size browser in both directions');
    await page.screenshot({path:'.cache/production-login-mobile.png'});
    await page.setViewportSize({width:1280,height:1000});
    assert.deepEqual(actions,['/api/me/accounts/qwen/connection/connect']);
    assert.equal(await page.locator('[data-provider=deepseek] [data-field=state]').textContent(),'Conectada');
    qwen='authenticated'; qwenLogin=false;
    // The real gateway closes VNC as soon as login is confirmed, before the
    // next account refresh. The success notice must survive that disconnect.
    await page.evaluate(async path => { const {default:RFB}=await import(path); RFB.current.dispatchEvent(new Event('disconnect')); }, '/novnc/core/rfb.js');
    await page.locator('#remote-panel').waitFor({state:'hidden'});
    assert.equal(await page.evaluate(()=>document.body.classList.contains('remote-open')),false);
    await page.locator('#message').filter({hasText:'Qwen conectado. A tela de login foi fechada automaticamente.'}).waitFor();
    assert.equal(await page.locator('[data-provider=qwen] [data-field=state]').textContent(),'Conectada');
    assert.equal(await page.locator('[data-provider=qwen]').getByRole('button',{name:'Reconectar conta',exact:true}).count(),1);
    assert.deepEqual(actions,['/api/me/accounts/qwen/connection/connect'], 'closing the login viewer must not start another login');
    assert.match(await page.locator('#available-models').textContent() || '',/qwen\/test-model/);
    await page.locator('[data-provider=deepseek]').getByRole('button',{name:'Reconectar conta',exact:true}).click();
    await page.locator('#remote-panel').waitFor({state:'visible'});
    await page.locator('#remote-finish').click();
    await page.locator('#remote-message').filter({hasText:'Conclua o login antes de confirmar.'}).waitFor();
    assert.equal(await page.locator('#remote-panel').isVisible(),true,'a rejected confirmation keeps the remote login available');
    await page.locator('#remote-finish').click();
    await page.locator('#remote-panel').waitFor({state:'hidden'});
    await page.locator('#message').filter({hasText:'DeepSeek conectado.'}).waitFor();
    assert.equal(finishAttempts,2);
    await mkdir('.cache',{recursive:true}); await page.screenshot({path:'.cache/production-desktop.png',fullPage:true});
    account='suspended'; await page.locator('#refresh').click();
    await page.locator('[data-provider=deepseek] [data-field=state]').filter({hasText:'Suspensa pelo provedor'}).waitFor();
    restricted=true;
    await page.locator('[data-provider=deepseek]').getByRole('button',{name:'Conectar',exact:true}).click();
    await page.locator('#remote-panel').waitFor({state:'visible'});
    await page.locator('#remote-finish').click();
    await page.locator('#remote-panel').waitFor({state:'hidden'});
    await page.locator('#message').filter({hasText:'Login do DeepSeek confirmado e sessão salva. A conta está bloqueada pelo provedor'}).waitFor();
    await page.locator('[data-provider=deepseek] [data-field=state]').filter({hasText:'Autenticada · conta bloqueada'}).waitFor();
    assert.match(await page.locator('[data-provider=deepseek]').textContent() || '', /Sessão salva/);
    assert.equal(await page.locator('[data-provider=deepseek] [data-field=provider-message]').textContent(), 'Aviso do provedor: '+providerMessage);
    assert.equal(await page.locator('[data-field=provider-message] img').count(), 0, 'provider text must never be interpreted as HTML');
    assert.doesNotMatch(await page.locator('#available-models').textContent() || '', /deepseek-/);
    await page.setViewportSize({width:390,height:844});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
    await page.screenshot({path:'.cache/production-mobile.png',fullPage:true});
    await page.locator('[data-provider=chatgpt]').getByRole('button',{name:'Conectar',exact:true}).click();
    await page.locator('#remote-panel').waitFor({state:'visible'});
    assert.equal(await page.locator('#remote-title').textContent(),'Entre no ChatGPT');
    assert.equal(await page.locator('#remote-finish').isVisible(),true);
    assert.match(await page.locator('#remote-help').textContent() || '', /Após entrar no ChatGPT.*Concluir login/);
    const finishBounds = await page.locator('#remote-finish').boundingBox();
    assert.ok(finishBounds && finishBounds.y >= 0 && finishBounds.y + finishBounds.height <= 844);
    // Changes to the account capability must update a viewer that is already open.
    chatgptManual = false;
    await page.evaluate(() => document.getElementById('refresh')!.click());
    await page.locator('#remote-finish').waitFor({state:'hidden'});
    chatgptManual = true;
    await page.evaluate(() => document.getElementById('refresh')!.click());
    await page.locator('#remote-finish').waitFor({state:'visible'});
    await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('#remote-finish')!.disabled);
    await page.screenshot({path:'.cache/chatgpt-login-mobile.png'});
    await page.locator('#remote-finish').click();
    await page.evaluate(async path => { const {default:RFB}=await import(path); RFB.current.dispatchEvent(new Event('disconnect')); }, '/novnc/core/rfb.js');
    await page.locator('#message').filter({hasText:'Conclua o acesso ao ChatGPT e tente novamente.'}).waitFor();
    assert.equal(await page.locator('[data-provider=chatgpt]').getByRole('button',{name:'Concluir login',exact:true}).isVisible(),true);
    await page.locator('[data-provider=chatgpt]').getByRole('button',{name:'Abrir login',exact:true}).click();
    await page.locator('#remote-panel').waitFor({state:'visible'});
    holdAccountRefresh = true;
    await page.locator('#remote-finish').click();
    // VNC can disconnect before finish succeeds, leaving an older poll in flight.
    await page.evaluate(async path => { const {default:RFB}=await import(path); RFB.current.dispatchEvent(new Event('disconnect')); }, '/novnc/core/rfb.js');
    await page.locator('#remote-panel').waitFor({state:'hidden'});
    await page.locator('[data-provider=chatgpt] [data-field=state]').filter({hasText:'Limite de uso atingido'}).waitFor();
    await page.locator('#message').filter({hasText:'ChatGPT conectado. Sessão salva.'}).waitFor();
    assert.match(await page.locator('[data-provider=chatgpt]').textContent() || '',/Login ativo.*Próxima tentativa:/s);
    await page.locator('#logout').click(); await page.locator('#authentication').waitFor({state:'visible'});
    assert.equal(await page.locator('#key-secret').textContent(),'');
    assert.equal(await page.locator('#new-key').isVisible(),false); assert.deepEqual(errors,[]);
  } finally { await browser.close(); }
});
