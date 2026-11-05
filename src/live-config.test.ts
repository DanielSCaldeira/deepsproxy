import test from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { setCookie, getCookie } from 'hono/cookie';
import { serve } from '@hono/node-server';
import { chromium } from 'playwright';
import { productionConfig } from './production/config.ts';

test('live mode allows HTTP only on localhost and keeps production HTTPS enforcement',t=>{
  const names=['PUBLIC_ORIGIN','LOCAL_LIVE_TEST','BOOTSTRAP_TOKEN','PROVISIONER_TOKEN','WORKER_MASTER_SECRET','DATABASE_URL'];
  const before=Object.fromEntries(names.map(name=>[name,process.env[name]]));
  t.after(()=>{for(const [name,value] of Object.entries(before)){if(value===undefined)delete process.env[name];else process.env[name]=value;}});
  Object.assign(process.env,{BOOTSTRAP_TOKEN:'b'.repeat(64),PROVISIONER_TOKEN:'p'.repeat(64),WORKER_MASTER_SECRET:'w'.repeat(64),DATABASE_URL:'postgres://fixture',PUBLIC_ORIGIN:'http://localhost:3440'});
  delete process.env.LOCAL_LIVE_TEST;
  assert.throws(()=>productionConfig(),/HTTPS/);
  process.env.LOCAL_LIVE_TEST='1'; assert.equal(productionConfig().origin,'http://localhost:3440');
  for(const origin of ['http://example.com','http://0.0.0.0:3440','http://localhost.example.com','http://localhost:3440/path']){
    process.env.PUBLIC_ORIGIN=origin; assert.throws(()=>productionConfig());
  }
  process.env.PUBLIC_ORIGIN='https://proxy.example.com'; delete process.env.LOCAL_LIVE_TEST;
  assert.equal(productionConfig().origin,'https://proxy.example.com');
});

test('Chromium accepts the unchanged Secure Host session cookie on localhost',async()=>{
  const app=new Hono();
  app.get('/',c=>{setCookie(c,'__Host-dsp','fixture',{secure:true,httpOnly:true,sameSite:'Strict',path:'/'});return c.text('local');});
  app.get('/session',c=>c.json({authenticated:getCookie(c,'__Host-dsp')==='fixture'}));
  const server=serve({fetch:app.fetch,hostname:'127.0.0.1',port:0});
  await new Promise<void>(resolve=>server.once('listening',resolve));
  const address=server.address(); if(!address||typeof address==='string')throw new Error('Missing server address');
  const browser=await chromium.launch();
  try{
    const page=await browser.newPage(); await page.goto(`http://localhost:${address.port}`);
    const state=await page.evaluate(async()=>{const response=await fetch('/session');return response.json();});
    assert.equal(state.authenticated,true);
  }finally{await browser.close();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
