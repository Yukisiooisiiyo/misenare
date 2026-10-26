// SMTP を話す。外部の部品は使わない。
//
// なぜ SMTP か：家電量販の実店舗では Slack を使っていない会社も多い。
// メールならどの会社も確実に持っている。しかも SMTP なら、
// 相手が **いま使っているメールサーバーをそのまま使える**。
//   会社の Microsoft 365 / Google Workspace … どちらも SMTP を持っている
//   Amazon SES / SendGrid                   … どちらも SMTP の窓口がある
//   会社の中のメールサーバー                 … これも SMTP
// 1つ実装すれば全部に届くので、送信業者に縛られない。
// （業者ごとの HTTP の API に寄せると、乗り換えのたびに作り直しになる）
//
// 対応する範囲は、業務の知らせを送るのに要るところだけ：
//   * 465 番の直接 TLS と、587 番の STARTTLS
//   * AUTH PLAIN と AUTH LOGIN
//   * 1通ずつ送る（まとめ送りはしない。失敗の切り分けが難しくなる）
// 添付・複数宛先の最適化・配信の再試行はしない。要るようになってから足す。

import { readFileSync } from 'node:fs';
import { connect as netConnect, type Socket } from 'node:net';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';

export interface SmtpConfig {
  host: string;
  port: number;
  /** 最初から TLS でつなぐ（465 番）。false なら STARTTLS に上げる（587 番） */
  secure: boolean;
  user?: string | undefined;
  pass?: string | undefined;
  /** 暗号化しないままの送信を許す（社内のメールサーバー向け。既定は許さない） */
  allowPlaintext?: boolean;
  /**
   * 相手の証明書を確かめるための、自前の認証局（PEM）。
   * 社内のメールサーバーが自前の認証局で証明書を出している場合に要る。
   * **確かめ方を緩めるのではなく、確かめる相手を足すだけ**（なりすましは止まる）。
   */
  ca?: string | undefined;
  /** 1回のやり取りの待ち時間 */
  timeoutMs?: number;
}

export interface Envelope {
  from: string;
  to: string[];
  /** DATA に流す本文（ヘッダーを含む、組み立て済みのもの） */
  message: string;
}

export class SmtpError extends Error {
  constructor(message: string, readonly code?: number) { super(message); }
}

/** 1行のやり取りを読み書きする薄い包み */
class Conversation {
  private buffer = '';
  private waiting: ((line: string) => void) | null = null;
  private failure: Error | null = null;
  private readonly lines: string[] = [];

  constructor(
    private socket: Socket | TLSSocket,
    private readonly timeoutMs: number,
    private readonly ca?: string | undefined,
  ) {
    this.attach();
  }

  private attach(): void {
    this.socket.setEncoding('utf8');
    this.socket.on('data', (chunk: string) => {
      this.buffer += chunk;
      // 答えは「250-…」が続き、最後が「250 …」で終わる。行ごとに溜める
      let at = this.buffer.indexOf('\r\n');
      while (at >= 0) {
        this.lines.push(this.buffer.slice(0, at));
        this.buffer = this.buffer.slice(at + 2);
        at = this.buffer.indexOf('\r\n');
      }
      this.drain();
    });
    const fail = (err: Error): void => {
      this.failure = err;
      this.drain();
    };
    this.socket.on('error', fail);
    this.socket.on('close', () => fail(new SmtpError('接続が切れました')));
  }

  private drain(): void {
    if (!this.waiting) return;
    if (this.failure) {
      const w = this.waiting;
      this.waiting = null;
      w('');
      return;
    }
    const line = this.lines.shift();
    if (line === undefined) return;
    const w = this.waiting;
    this.waiting = null;
    w(line);
  }

  /** 相手の答えを1つ読む。複数行の答えは最後の行まで読む */
  async reply(): Promise<{ code: number; text: string }> {
    const collected: string[] = [];
    for (;;) {
      const line = await this.line();
      collected.push(line);
      // 「250-」は続き、「250 」で終わり
      if (line.length < 4 || line[3] !== '-') break;
    }
    const last = collected.at(-1)!;
    const code = Number(last.slice(0, 3));
    const text = collected.map((l) => l.slice(4)).join('\n');
    if (!Number.isFinite(code)) throw new SmtpError(`答えを読めません: ${last}`);
    return { code, text };
  }

  private line(): Promise<string> {
    if (this.failure) return Promise.reject(this.failure);
    const ready = this.lines.shift();
    if (ready !== undefined) return Promise.resolve(ready);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting = null;
        reject(new SmtpError('相手の答えを待って時間切れになりました'));
      }, this.timeoutMs);
      this.waiting = (line: string) => {
        clearTimeout(timer);
        if (this.failure) reject(this.failure);
        else resolve(line);
      };
      this.drain();
    });
  }

  write(text: string): void {
    this.socket.write(text);
  }

  /** 送って、答えの番号を確かめる */
  async send(command: string, expect: number[], what: string): Promise<{ code: number; text: string }> {
    this.write(`${command}\r\n`);
    const r = await this.reply();
    if (!expect.includes(r.code)) throw new SmtpError(`${what}を断られました: ${r.code} ${r.text}`, r.code);
    return r;
  }

  /** STARTTLS のあと、同じ接続を TLS に差し替える */
  upgrade(host: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const plain = this.socket;
      plain.removeAllListeners('data');
      plain.removeAllListeners('error');
      plain.removeAllListeners('close');
      const secure = tlsConnect({ socket: plain, servername: host, ...(this.ca ? { ca: this.ca } : {}) }, () => {
        this.socket = secure;
        this.buffer = '';
        this.lines.length = 0;
        this.failure = null;
        this.attach();
        resolve();
      });
      secure.once('error', reject);
    });
  }

  end(): void {
    this.socket.destroy();
  }
}

function openSocket(config: SmtpConfig): Promise<Socket | TLSSocket> {
  const timeout = config.timeoutMs ?? 20_000;
  return new Promise((resolve, reject) => {
    const socket = config.secure
      ? tlsConnect({
          host: config.host, port: config.port, servername: config.host,
          ...(config.ca ? { ca: config.ca } : {}),
        }, () => resolve(socket))
      : netConnect({ host: config.host, port: config.port }, () => resolve(socket));
    socket.setTimeout(timeout, () => {
      socket.destroy();
      reject(new SmtpError(`${config.host}:${config.port} につながりませんでした（時間切れ）`));
    });
    socket.once('error', reject);
  });
}

/**
 * 1通送る。
 *
 * **暗号化されていない接続では、既定で送らない。** 認証の合言葉と本文が
 * そのまま流れるため。社内のメールサーバーのように閉じた経路で使うときだけ、
 * allowPlaintext で許す。
 */
export async function sendSmtp(config: SmtpConfig, envelope: Envelope): Promise<void> {
  const socket = await openSocket(config);
  const talk = new Conversation(socket, config.timeoutMs ?? 20_000, config.ca);
  let encrypted = config.secure;
  try {
    const greeting = await talk.reply();
    if (greeting.code !== 220) throw new SmtpError(`挨拶を受け取れませんでした: ${greeting.code} ${greeting.text}`);

    const hello = await talk.send(`EHLO ${hostnameForEhlo()}`, [250], '挨拶');
    if (!encrypted && /\bSTARTTLS\b/i.test(hello.text)) {
      await talk.send('STARTTLS', [220], '暗号化の開始');
      await talk.upgrade(config.host);
      encrypted = true;
      // TLS に上げたら、もう一度名乗り直す決まり
      await talk.send(`EHLO ${hostnameForEhlo()}`, [250], '挨拶（暗号化のあと）');
    }
    if (!encrypted && config.allowPlaintext !== true) {
      throw new SmtpError(
        'この相手は暗号化に対応していません。SMTP_ALLOW_PLAINTEXT=1 を決めるか、暗号化できる窓口（587 か 465）を使ってください',
      );
    }

    if (config.user) {
      // AUTH PLAIN が通る相手が多いが、LOGIN しか受けない相手もいる
      const methods = /AUTH[ =]([^\n]*)/i.exec(hello.text)?.[1]?.toUpperCase() ?? '';
      const pass = config.pass ?? '';
      if (methods.includes('PLAIN') || methods === '') {
        const token = Buffer.from(`\0${config.user}\0${pass}`, 'utf8').toString('base64');
        await talk.send(`AUTH PLAIN ${token}`, [235], '認証');
      } else if (methods.includes('LOGIN')) {
        await talk.send('AUTH LOGIN', [334], '認証');
        await talk.send(Buffer.from(config.user, 'utf8').toString('base64'), [334], '認証（利用者名）');
        await talk.send(Buffer.from(pass, 'utf8').toString('base64'), [235], '認証（合言葉）');
      } else {
        throw new SmtpError(`対応している認証方式がありません（相手: ${methods}）`);
      }
    }

    await talk.send(`MAIL FROM:<${envelope.from}>`, [250], '差出人');
    for (const to of envelope.to) await talk.send(`RCPT TO:<${to}>`, [250, 251], `宛先（${to}）`);
    await talk.send('DATA', [354], '本文の開始');
    talk.write(`${stuff(envelope.message)}\r\n.\r\n`);
    const accepted = await talk.reply();
    if (accepted.code !== 250) throw new SmtpError(`本文を断られました: ${accepted.code} ${accepted.text}`, accepted.code);
    // QUIT の答えは待たない（切られても送信は済んでいる）
    talk.write('QUIT\r\n');
  } finally {
    talk.end();
  }
}

/**
 * 本文の中の「.」だけの行は、終わりの合図と同じ形なので「..」に増やす。
 * これを忘れると、本文が途中で切れる（SMTP で最初に踏む落とし穴）。
 */
export function stuff(message: string): string {
  return message.replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..');
}

/** EHLO で名乗る名前。相手は参考程度にしか見ないが、形は要る */
function hostnameForEhlo(): string {
  return process.env.SMTP_EHLO_NAME ?? 'misenare.local';
}

/** 環境変数から送信の設定を決める。決めていなければ null（メールを送らない） */
export function smtpFromEnv(env: NodeJS.ProcessEnv = process.env): SmtpConfig | null {
  const host = env.SMTP_HOST;
  if (!host) return null;
  const port = Number(env.SMTP_PORT ?? 587);
  return {
    host,
    port,
    // 465 は最初から TLS、587 は STARTTLS に上げる、が決まり
    secure: env.SMTP_SECURE === '1' || (env.SMTP_SECURE !== '0' && port === 465),
    user: env.SMTP_USER,
    pass: env.SMTP_PASS,
    allowPlaintext: env.SMTP_ALLOW_PLAINTEXT === '1',
    ...(env.SMTP_CA_FILE ? { ca: readFileSync(env.SMTP_CA_FILE, 'utf8') } : {}),
    ...(env.SMTP_TIMEOUT_MS ? { timeoutMs: Number(env.SMTP_TIMEOUT_MS) } : {}),
  };
}
