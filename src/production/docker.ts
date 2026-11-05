import http from 'node:http';

export class DockerError extends Error {
  override name = 'DockerError';
  constructor(public status: number, public detail = '', public operation = '') {
    super(`Docker returned ${status}${operation ? ` on ${operation}` : ''}${detail ? `: ${detail}` : ''}`);
  }
}
/** Docker error bodies are `{ message }`; request bodies (which carry secrets) are never included. */
function dockerDetail(text: string) {
  try { const message = JSON.parse(text)?.message; if (typeof message === 'string') return message.slice(0, 500); } catch { /* not JSON */ }
  return text.trim().slice(0, 500);
}
/** Fixed Unix socket; callers cannot supply a host, image, command, mount, or URL. */
export async function docker(method: string, path: string, body?: unknown): Promise<any> {
  const raw = await dockerRaw(method, path, body);
  const text = raw.toString();
  return text ? JSON.parse(text) : {};
}
/** Tail of a container's stdout/stderr (non-TTY multiplexed stream), for diagnostics. */
export async function containerLogs(id: string, tail = 40): Promise<string> {
  const raw = await dockerRaw('GET', `/containers/${encodeURIComponent(id)}/logs?stdout=1&stderr=1&tail=${tail}`);
  const lines: string[] = [];
  for (let offset = 0; offset + 8 <= raw.length;) {
    const size = raw.readUInt32BE(offset + 4);
    lines.push(raw.subarray(offset + 8, offset + 8 + size).toString());
    offset += 8 + size;
  }
  return (lines.length ? lines.join('') : raw.toString()).trim();
}
function dockerRaw(method: string, path: string, body?: unknown): Promise<Buffer> {
  return new Promise((resolve,reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const request = http.request({ socketPath:'/var/run/docker.sock', path:'/v1.48'+path, method,
      headers: data ? { 'Content-Type':'application/json','Content-Length':Buffer.byteLength(data) } : {} }, response => {
      const chunks: Buffer[] = []; let size=0;
      response.on('data',chunk => { size+=chunk.length; if(size>8*1024*1024) { request.destroy(new Error('Docker response too large')); return; } chunks.push(chunk); });
      response.on('end',()=> {
        if ((response.statusCode || 500)>=300) { reject(new DockerError(response.statusCode || 500, dockerDetail(Buffer.concat(chunks).toString()), `${method} ${path.split('?')[0]}`)); return; }
        resolve(Buffer.concat(chunks));
      });
    });
    request.on('error',reject); request.setTimeout(60_000,()=>request.destroy(new Error('Docker timeout')));
    if (data) request.write(data); request.end();
  });
}
