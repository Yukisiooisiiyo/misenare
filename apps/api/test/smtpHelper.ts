// にせのメールサーバー。SMTP のやり取りを受けて、来たものを全部覚える。
//
// 本物のメールサーバーに当てる試験はできない（相手の都合で落ちる・遅い・
// 送ったものが人に届く）。確かめたいのは**こちらの話し方**なので、相手を自分で作る。
// STARTTLS まで通すために、その場で証明書を作る（openssl）。

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer as createNetServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TLSSocket } from 'node:tls';

export interface Received {
  from: string;
  to: string[];
  /** DATA で流れてきた中身（ヘッダーを含む） */
  data: string;
  /** 認証に使われた利用者名と合言葉 */
  auth: { user: string; pass: string } | null;
  /** 暗号化された接続で受けたか */
  encrypted: boolean;
  /** 相手（こちら）が送ってきた命令の並び */
  commands: string[];
}

export interface FakeSmtp {
  port: number;
  /** 自前の認証局（＝この証明書）。SmtpConfig.ca に渡す */
  ca: string;
  received: Received[];
  /** 次の命令に、わざと断りを返す（失敗の扱いを試すため） */
  refuse(command: string, reply: string): void;
  close(): Promise<void>;
}

export interface FakeSmtpOptions {
  /** 名乗りで出す対応機能。STARTTLS を外すと、暗号化できない相手になる */
  capabilities?: string[];
  requireAuth?: boolean;
}

/** その場で自己署名の証明書を作る。openssl が無ければ null */
function makeCertificate(): { key: string; cert: string; dir: string } | null {
  const dir = mkdtempSync(join(tmpdir(), 'misenare-smtp-'));
  try {
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem'),
      '-days', '2', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost',
    ], { stdio: 'ignore' });
  } catch {
    rmSync(dir, { recursive: true, force: true });
    return null;
  }
  return {
    key: readFileSync(join(dir, 'key.pem'), 'utf8'),
    cert: readFileSync(join(dir, 'cert.pem'), 'utf8'),
    dir,
  };
}

export async function fakeSmtp(options: FakeSmtpOptions = {}): Promise<FakeSmtp | null> {
  const certificate = makeCertificate();
  if (!certificate) return null;
  const capabilities = options.capabilities ?? ['STARTTLS', 'AUTH PLAIN LOGIN'];
  const received: Received[] = [];
  const refusals = new Map<string, string>();

  const handle = (socket: Socket): void => {
    let state: 'commands' | 'data' | 'authUser' | 'authPass' = 'commands';
    let buffer = '';
    let body = '';
    const entry: Received = { from: '', to: [], data: '', auth: null, encrypted: false, commands: [] };
    let active = socket;

    const write = (line: string): void => { active.write(`${line}\r\n`); };

    const onLine = (line: string): void => {
      if (state === 'data') {
        if (line === '.') {
          entry.data = body;
          entry.encrypted = active instanceof TLSSocket;
          received.push({ ...entry, to: [...entry.to], commands: [...entry.commands] });
          body = '';
          state = 'commands';
          write('250 2.0.0 受け取りました');
          return;
        }
        // 「..」で来た行は「.」に戻す（こちらが増やしたぶん）
        body += `${line.startsWith('..') ? line.slice(1) : line}\n`;
        return;
      }
      if (state === 'authUser') {
        entry.auth = { user: Buffer.from(line, 'base64').toString('utf8'), pass: '' };
        state = 'authPass';
        write('334 UGFzc3dvcmQ6');
        return;
      }
      if (state === 'authPass') {
        if (entry.auth) entry.auth.pass = Buffer.from(line, 'base64').toString('utf8');
        state = 'commands';
        write('235 2.7.0 認証しました');
        return;
      }

      const verb = line.split(' ')[0]!.toUpperCase();
      entry.commands.push(verb);
      const refusal = refusals.get(verb);
      if (refusal) {
        refusals.delete(verb);
        write(refusal);
        return;
      }
      if (verb === 'EHLO' || verb === 'HELO') {
        const list = active instanceof TLSSocket
          ? capabilities.filter((c) => !c.startsWith('STARTTLS'))
          : capabilities;
        write('250-にせのメールサーバー');
        for (const [i, c] of list.entries()) write(`250${i === list.length - 1 ? ' ' : '-'}${c}`);
        return;
      }
      if (verb === 'STARTTLS') {
        write('220 2.0.0 どうぞ');
        socket.removeAllListeners('data');
        const secure = new TLSSocket(socket, {
          isServer: true, key: certificate.key, cert: certificate.cert,
        });
        active = secure as unknown as Socket;
        secure.setEncoding('utf8');
        secure.on('data', onData);
        secure.on('error', () => {});
        return;
      }
      if (verb === 'AUTH') {
        const [, method, token] = line.split(' ');
        if ((method ?? '').toUpperCase() === 'PLAIN') {
          const parts = Buffer.from(token ?? '', 'base64').toString('utf8').split('\0');
          entry.auth = { user: parts[1] ?? '', pass: parts[2] ?? '' };
          write('235 2.7.0 認証しました');
          return;
        }
        state = 'authUser';
        write('334 VXNlcm5hbWU6');
        return;
      }
      if (verb === 'MAIL') {
        if (options.requireAuth && !entry.auth) { write('530 5.7.0 先に認証してください'); return; }
        entry.from = /<([^>]*)>/.exec(line)?.[1] ?? '';
        write('250 2.1.0 はい');
        return;
      }
      if (verb === 'RCPT') {
        entry.to.push(/<([^>]*)>/.exec(line)?.[1] ?? '');
        write('250 2.1.5 はい');
        return;
      }
      if (verb === 'DATA') { state = 'data'; write('354 本文をどうぞ'); return; }
      if (verb === 'QUIT') { write('221 2.0.0 さようなら'); active.end(); return; }
      write('250 2.0.0 はい');
    };

    const onData = (chunk: string): void => {
      buffer += chunk;
      let at = buffer.indexOf('\r\n');
      while (at >= 0) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 2);
        onLine(line);
        at = buffer.indexOf('\r\n');
      }
    };

    socket.setEncoding('utf8');
    socket.on('data', onData);
    socket.on('error', () => {});
    write('220 にせのメールサーバー です');
  };

  const server: Server = createNetServer(handle);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  return {
    port,
    ca: certificate.cert,
    received,
    refuse(command, reply) { refusals.set(command.toUpperCase(), reply); },
    close() {
      rmSync(certificate.dir, { recursive: true, force: true });
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
