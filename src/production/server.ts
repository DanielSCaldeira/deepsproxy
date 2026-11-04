import 'dotenv/config';
import { serve } from '@hono/node-server';
import { WebSocketServer, WebSocket } from 'ws';
import { connect } from 'node:net';
import { readFile } from 'node:fs/promises';
import { productionConfig } from './config.ts';
import { connectDatabase, migrate } from './database.ts';
import { createGateway } from './gateway.ts';
import { Workers } from './workers.ts';

const config = productionConfig();
const db = connectDatabase(config.database);
await migrate(db);
const workers = new Workers(config, db);
await workers.initialize();
const gateway = createGateway(db,workers,config);
gateway.app.get('/assets/panel.js', async c => c.body(await readFile(new URL('../../public/panel.js',import.meta.url),'utf8'),200,{'Content-Type':'text/javascript'}));
gateway.app.get('/novnc/*', async c => {
  if (!await gateway.identity(c.req.raw.headers)) return c.text('Unauthorized',401);
  const relative = c.req.path.slice('/novnc/'.length);
  if (!/^(core|vendor)\/[a-zA-Z0-9_/.\-]+\.js$/.test(relative) || relative.split('/').some(p=>p==='..')) return c.notFound();
  try { return c.body(await readFile(new URL('../../node_modules/@novnc/novnc/'+relative,import.meta.url),'utf8'),200,{'Content-Type':'text/javascript'}); }
  catch { return c.notFound(); }
});
const server = serve({ fetch: gateway.app.fetch, hostname:'0.0.0.0', port:Number(process.env.PORT || 3000) });
const sockets = new WebSocketServer({ noServer:true, maxPayload:64*1024, perMessageDeflate:false });
server.on('upgrade', (request, socket, head) => {
  void (async () => {
    const url = new URL(request.url || '/',config.origin);
    if (url.pathname !== '/api/me/remote') throw new Error('path');
    const headers = new Headers();
    for (const [key,value] of Object.entries(request.headers)) if (value) headers.set(key,Array.isArray(value)?value.join('; '):String(value));
    const remote = await gateway.authorizeRemote(headers,url.searchParams.get('ticket') || '',request.headers.origin || '');
    sockets.handleUpgrade(request,socket,head, ws => {
      // There is exactly one remote viewer for this login lease.
      remote.login.close();
      const upstream = connect({host:remote.worker.host,port:5900});
      const close = () => { upstream.destroy(); if (ws.readyState === WebSocket.OPEN) ws.close(); else ws.terminate(); };
      remote.login.close = close;
      ws.on('message',data => { if (!upstream.write(data as Buffer)) ws.pause(); });
      upstream.on('drain',()=>ws.resume());
      upstream.on('data',data => {
        if (ws.readyState !== WebSocket.OPEN) return;
        upstream.pause(); ws.send(data,{binary:true},error => { if (error) close(); else upstream.resume(); });
      });
      upstream.on('error',close); upstream.on('close',()=>ws.close()); ws.on('error',close);
      ws.on('close',()=> { upstream.destroy(); if (remote.login.close === close) workers.cancel(remote.id,remote.session); });
    });
  })().catch(()=> { socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); socket.destroy(); });
});
let ticking = false;
const timer = setInterval(()=> {
  if (ticking) return;
  ticking = true;
  void gateway.tick().catch(()=>console.error('[gateway] browser supervision failed')).finally(()=> { ticking=false; });
},5000);
const cleanup = setInterval(()=> { void db.query("DELETE FROM sessions WHERE expires_at<now(); DELETE FROM links WHERE expires_at<now()-interval '7 days'; DELETE FROM operations WHERE created_at<now()-interval '30 days'; DELETE FROM audit WHERE created_at<now()-interval '90 days'").catch(()=>{}); },3600_000);
const stop = () => { clearInterval(timer); clearInterval(cleanup); for(const ws of sockets.clients) ws.terminate(); server.close(()=> { void db.end().then(()=>process.exit(0)); }); };
process.once('SIGTERM',stop); process.once('SIGINT',stop);
console.info('[gateway] Production gateway listening');
