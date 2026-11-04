import http from 'node:http';

export class DockerError extends Error {
  constructor(public status: number) { super(`Docker returned ${status}`); }
}
/** Fixed Unix socket; callers cannot supply a host, image, command, mount, or URL. */
export function docker(method: string, path: string, body?: unknown): Promise<any> {
  return new Promise((resolve,reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const request = http.request({ socketPath:'/var/run/docker.sock', path:'/v1.48'+path, method,
      headers: data ? { 'Content-Type':'application/json','Content-Length':Buffer.byteLength(data) } : {} }, response => {
      const chunks: Buffer[] = []; let size=0;
      response.on('data',chunk => { size+=chunk.length; if(size>8*1024*1024) { request.destroy(new Error('Docker response too large')); return; } chunks.push(chunk); });
      response.on('end',()=> {
        if ((response.statusCode || 500)>=300) { reject(new DockerError(response.statusCode || 500)); return; }
        try { const text=Buffer.concat(chunks).toString(); resolve(text?JSON.parse(text):{}); } catch(error) { reject(error); }
      });
    });
    request.on('error',reject); request.setTimeout(60_000,()=>request.destroy(new Error('Docker timeout')));
    if (data) request.write(data); request.end();
  });
}
