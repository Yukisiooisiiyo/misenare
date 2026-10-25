// node:http の上で (Request) => Promise<Response> 形式のハンドラを動かす。

import { createServer, type IncomingMessage, type Server } from 'node:http';
import { CLIENT_IP_HEADER } from './rateLimit.ts';

const MAX_BODY = 1024 * 1024; // 1MB（ふつうの API）
// 写真の中身だけは大きい。S3 を使うときは端末から直接上がるので、これはローカル保存のときの上限。
const MAX_PHOTO_BODY = 4 * 1024 * 1024;

// 既存マニュアルの取り込み。資料そのものを送るので大きい
const MAX_IMPORT_BODY = 8 * 1024 * 1024;

function bodyLimit(req: IncomingMessage): number {
  const url = req.url ?? '';
  if (req.method === 'PUT' && /\/photos\/[^/]+\/data\/?$/.test(url)) return MAX_PHOTO_BODY;
  if (req.method === 'POST' && /\/imports(\?|$)/.test(url)) return MAX_IMPORT_BODY;
  return MAX_BODY;
}

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new Error('payload_too_large');
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
      // 接続元の IP。外から同名のヘッダーが来ても上書きする。
      // ロードバランサー（ALB）の後ろでは TRUST_PROXY=1 にし、X-Forwarded-For の最後（ALB が見た接続元）を使う
      const forwarded = req.headers['x-forwarded-for'];
      const fromProxy = process.env.TRUST_PROXY === '1' && typeof forwarded === 'string'
        ? forwarded.split(',').map((x) => x.trim()).filter(Boolean).at(-1)
        : undefined;
      headers.set(CLIENT_IP_HEADER, fromProxy ?? req.socket.remoteAddress ?? 'unknown');
      const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
      const body = hasBody ? await readBody(req, bodyLimit(req)) : undefined;
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
