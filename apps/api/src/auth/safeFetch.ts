// 外のサーバーに取りに行くときの安全な口。
//
// なぜ要るか：会社アカウント（OIDC）の設定では、**相手の文書が次の行き先を決める**。
// 発行元（issuer）を取りに行くと、その中に jwks_uri と token_endpoint が書いてあり、
// こちらはそこへ取りに行く。ここを確かめずに従うと、こちらのサーバーが
// 相手の指す好きな場所へ行くことになる（SSRF）。
//
//   jwks_uri: http://169.254.169.254/latest/meta-data/iam/security-credentials/
//     → クラウドの鍵を、こちらのサーバーが読んで相手に渡してしまう
//   jwks_uri: http://10.0.0.5:9000/admin
//     → 社内だけに開けている画面に、こちらのサーバーから手が届く
//
// 設定を入れるのは本部の管理者なので「身内」だが、
//   * 管理者の端末が乗っ取られたとき、ここが社内への入口になる
//   * 相手の IdP が乗っ取られたときも同じ
//   * 複数の会社が同じサーバーに乗る（SaaS）ので、1社から他社の経路に手が伸びる
// ——ので、身内かどうかとは別に塞ぐ。
//
// 塞ぎ方（1つでも抜けると意味がない）：
//   1. https だけ。http は認めない
//   2. 名前を引いて、**公開のアドレスでなければ断る**（社内・自分自身・クラウドの鍵置き場）
//   3. 引いたアドレスに**そのままつなぐ**。つなぐ直前にもう一度名前を引かせない
//      （引き直しの隙に社内のアドレスへ差し替える手口＝DNS リバインディングを止める）
//   4. 行き先の付け替え（リダイレクト）には従わない。公開の URL から社内へ飛ばせるため
//   5. 大きさと時間に上限。巨大な答えや、答えない相手で詰まらせない

import { lookup as dnsLookup } from 'node:dns';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';

/** 受け取る答えの上限。相手の設定も鍵も、ふつうは数十KB */
export const MAX_BYTES = 512 * 1024;
/** 1回のやり取りの上限 */
export const TIMEOUT_MS = 8_000;

export class FetchRefused extends Error {}

/**
 * 公開のアドレスか。公開でないものは全部断る。
 *
 * 「社内のこの範囲だけ許す」ではなく「公開でなければ断る」にしているのは、
 * 許す側を並べると必ず書き漏れるため（IPv6 の表し方だけでも何通りもある）。
 */
export function isPublicAddress(address: string): boolean {
  if (isIP(address) === 4) return isPublicV4(address);
  if (isIP(address) === 6) return isPublicV6(address);
  return false;
}

function isPublicV4(address: string): boolean {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = parts as [number, number, number, number];
  if (a === 0) return false;                        // 0.0.0.0/8
  if (a === 10) return false;                       // 社内
  if (a === 127) return false;                      // 自分自身
  if (a === 100 && b >= 64 && b <= 127) return false; // 事業者の内側（CGNAT）
  if (a === 169 && b === 254) return false;         // クラウドの鍵置き場（169.254.169.254）を含む
  if (a === 172 && b >= 16 && b <= 31) return false; // 社内
  if (a === 192 && b === 168) return false;          // 社内
  if (a === 192 && b === 0) return false;            // 用途が決まっている範囲
  if (a === 198 && (b === 18 || b === 19)) return false; // 試験用
  if (a === 198 && b === 51) return false;           // 文書用
  if (a === 203 && b === 0) return false;            // 文書用
  if (a >= 224) return false;                        // 同報・予約
  return true;
}

function isPublicV6(address: string): boolean {
  const lower = address.toLowerCase().split('%')[0]!;
  if (lower === '::' || lower === '::1') return false;        // 自分自身
  // IPv4 を IPv6 の形で書いたもの（::ffff:127.0.0.1 など）は、中身で判定する
  const mapped = /^(?:::ffff:)([0-9.]+)$/.exec(lower);
  if (mapped) return isPublicV4(mapped[1]!);
  if (/^f[cd]/.test(lower)) return false;  // fc00::/7 社内
  if (/^fe[89ab]/.test(lower)) return false; // fe80::/10 同じ回線の中だけ
  if (/^ff/.test(lower)) return false;      // 同報
  if (lower.startsWith('2001:db8')) return false; // 文書用
  if (lower.startsWith('64:ff9b')) return false;  // IPv4 への橋渡し
  return true;
}

/** 名前を引いて、**全部**のアドレスが公開かを確かめる。1つでも社内なら断る */
export async function resolvePublic(hostname: string): Promise<string> {
  // そのままアドレスが書かれているなら、引かずに判定する
  if (isIP(hostname) !== 0) {
    if (!isPublicAddress(hostname)) throw new FetchRefused(`${hostname} は外から見えないアドレスです`);
    return hostname;
  }
  const addresses = await new Promise<Array<{ address: string }>>((resolve, reject) => {
    dnsLookup(hostname, { all: true }, (err, list) => (err ? reject(err) : resolve(list)));
  }).catch((err: Error) => {
    throw new FetchRefused(`${hostname} の名前を引けませんでした: ${err.message}`);
  });
  if (addresses.length === 0) throw new FetchRefused(`${hostname} のアドレスが見つかりません`);
  for (const { address } of addresses) {
    if (!isPublicAddress(address)) {
      throw new FetchRefused(`${hostname} は外から見えないアドレス（${address}）を指しています`);
    }
  }
  return addresses[0]!.address;
}

/**
 * URL の形を確かめる。https で、利用者名や合言葉が埋め込まれていないこと。
 * 返すのは解析済みの URL（呼ぶ側が host などを使う）。
 */
export function requireSafeUrl(value: string, what: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new FetchRefused(`${what}の形が違います`);
  }
  if (url.protocol !== 'https:') throw new FetchRefused(`${what}は https である必要があります（${url.protocol} は認めません）`);
  if (url.username !== '' || url.password !== '') throw new FetchRefused(`${what}に利用者名や合言葉は付けられません`);
  return url;
}

export interface SafeRequest {
  url: string;
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
}

export interface SafeResponse {
  status: number;
  text: string;
}

/**
 * 取りに行く。上の1〜5を全部通したうえで取る。
 *
 * fetch を使わずに node:https を直に使っているのは、**つなぐアドレスを指定できる**から。
 * fetch では、名前を確かめたあとにもう一度名前が引かれるので、その隙に
 * 社内のアドレスへ差し替えられる（DNS リバインディング）。
 */
export async function safeFetch(req: SafeRequest): Promise<SafeResponse> {
  const url = requireSafeUrl(req.url, '行き先');
  const address = await resolvePublic(url.hostname);

  return new Promise<SafeResponse>((resolve, reject) => {
    const client = httpsRequest(
      {
        host: url.hostname,
        servername: url.hostname,
        port: url.port === '' ? 443 : Number(url.port),
        path: `${url.pathname}${url.search}`,
        method: req.method ?? 'GET',
        headers: { accept: 'application/json', ...req.headers },
        timeout: TIMEOUT_MS,
        // 確かめたアドレスにそのままつなぐ（名前を引き直させない）
        lookup: (_hostname, options, callback) => {
          const family = isIP(address);
          if (typeof options === 'function') (options as (e: Error | null, a: string, f: number) => void)(null, address, family);
          else (callback as (e: Error | null, a: string, f: number) => void)(null, address, family);
        },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        // 行き先の付け替えには従わない。公開の URL から社内へ飛ばせるため
        if (status >= 300 && status < 400) {
          res.destroy();
          reject(new FetchRefused(`行き先の付け替え（${status}）には従いません。最終的な URL を設定してください`));
          return;
        }
        let size = 0;
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_BYTES) {
            res.destroy();
            reject(new FetchRefused(`答えが大きすぎます（${MAX_BYTES} バイトまで）`));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => resolve({ status, text: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', (err) => reject(err));
      },
    );
    client.on('timeout', () => {
      client.destroy(new FetchRefused(`${url.hostname} が ${TIMEOUT_MS}ms 以内に答えませんでした`));
    });
    client.on('error', (err) => reject(err instanceof FetchRefused ? err : new FetchRefused(`${url.hostname} につながりませんでした: ${err.message}`)));
    if (req.body !== undefined) client.write(req.body);
    client.end();
  });
}
