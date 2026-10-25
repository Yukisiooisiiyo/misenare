// node:http の上で (Request) => Promise<Response> 形式のハンドラを動かす。

import { createServer, type IncomingMessage, type Server } from 'node:http';

const MAX_BODY = 1024 * 1024; // 1MB（写真は端末から直接ストレージに上げるので、API には来ない）

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new Error('payload_too_large');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

export function serve(handler: (req: Request) => Promise<Response>, port: number): Server {
  const server = createServer(async (req, res) => {
    try {
      const url = `http://${req.headers.host ?? 'localhost'}${req.url ?? '/'}`;
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (Array.isArray(v)) v.forEach((x) => headers.append(k, x));
        else if (v !== undefined) headers.set(k, v);
      }
      const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
      const body = hasBody ? await readBody(req) : undefined;
      const response = await handler(new Request(url, { method: req.method ?? 'GET', headers, ...(body ? { body } : {}) }));
      res.statusCode = response.status;
      response.headers.forEach((value, key) => res.setHeader(key, value));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (err) {
      const tooLarge = err instanceof Error && err.message === 'payload_too_large';
      res.statusCode = tooLarge ? 413 : 500;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: tooLarge ? 'payload_too_large' : 'internal' }));
    }
  });
  server.listen(port);
  return server;
}
