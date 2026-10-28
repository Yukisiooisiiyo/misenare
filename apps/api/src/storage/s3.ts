// S3 の署名付きURL（AWS Signature Version 4、クエリ文字列方式）を、依存なしで作る。
//
// 署名の手順は AWS の仕様どおり：
//   1. 正規リクエスト（メソッド・パス・クエリ・ヘッダー・本文のハッシュ）を組み立てて SHA-256
//   2. 「AWS4-HMAC-SHA256 / 日時 / スコープ / 1のハッシュ」を署名対象の文字列にする
//   3. 秘密鍵から日付・リージョン・サービスの順に HMAC して署名鍵を作り、2 を HMAC する
//
// 本文のハッシュは UNSIGNED-PAYLOAD（署名付きURLでは中身を先に読めないため、AWS もこれを使う）。

import { createHash, createHmac } from 'node:crypto';

export interface S3Config {
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** 一時的な認証情報（IAM ロールなど）を使うとき */
  sessionToken?: string;
  /** S3 互換ストレージ向け。例：https://s3.example.com（省略すると AWS） */
  endpoint?: string;
}

const SERVICE = 's3';
const ALGORITHM = 'AWS4-HMAC-SHA256';

function sha256(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

function hmac(key: Uint8Array | string, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

/** RFC 3986 のエンコード。AWS は `!'()*` も必ずエンコードする */
export function uriEncode(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** パスは `/` を残して1区間ずつエンコードする */
function encodeKey(key: string): string {
  return key.split('/').map(uriEncode).join('/');
}

/** 2015-08-30T12:36:00Z → { date: '20150830', dateTime: '20150830T123600Z' } */
function stamps(now: Date): { date: string; dateTime: string } {
  const dateTime = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  return { date: dateTime.slice(0, 8), dateTime };
}

/** 秘密鍵から署名鍵を作る（日付 → リージョン → サービス → aws4_request の順に HMAC） */
export function signingKey(secretAccessKey: string, date: string, region: string, service = SERVICE): Buffer {
  const kDate = hmac(`AWS4${secretAccessKey}`, date);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, 'aws4_request');
}

function hostOf(config: S3Config): { host: string; origin: string; pathPrefix: string } {
  if (!config.endpoint) {
    const host = `${config.bucket}.${SERVICE}.${config.region}.amazonaws.com`;
    return { host, origin: `https://${host}`, pathPrefix: '' };
  }
  // 互換ストレージはパス形式（https://host/bucket/key）で扱う
  const url = new URL(config.endpoint);
  return { host: url.host, origin: url.origin, pathPrefix: `/${encodeKey(config.bucket)}` };
}

export interface PresignOptions {
  /** 有効時間（秒）。最大7日 */
  expiresIn: number;
  now: Date;
  /**
   * 署名に含める Content-Type。
   *
   * **含めないと、端末が好きな形式で保存できる。** S3 は送られてきた
   * Content-Type をそのまま覚えて、読むときもそのまま返す。しかも S3 の答えには
   * nosniff が付かないので、`text/html` で上げられると、会社のドメインの下に
   * 好きな中身を置けることになる（写真の中身はサーバーを通らないので、
   * こちら側で先頭を見て確かめることもできない）。
   * だから、置いてよい形式を署名に焼き込む。違う形式で送れば S3 が断る。
   */
  contentType?: string;
}

/** S3 の署名付きURLを作る */
export function presignS3(config: S3Config, method: 'GET' | 'PUT' | 'DELETE' | 'HEAD', key: string, opts: PresignOptions): string {
  const { date, dateTime } = stamps(opts.now);
  const { host, origin, pathPrefix } = hostOf(config);
  const scope = `${date}/${config.region}/${SERVICE}/aws4_request`;

  // 署名に含めるヘッダー。名前は小文字で、名前の順に並べる決まり
  const signed: Array<[string, string]> = [['host', host]];
  if (opts.contentType !== undefined) signed.push(['content-type', opts.contentType]);
  signed.sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const signedNames = signed.map(([k]) => k).join(';');

  const query: Array<[string, string]> = [
    ['X-Amz-Algorithm', ALGORITHM],
    ['X-Amz-Credential', `${config.accessKeyId}/${scope}`],
    ['X-Amz-Date', dateTime],
    ['X-Amz-Expires', String(opts.expiresIn)],
    ['X-Amz-SignedHeaders', signedNames],
  ];
  if (config.sessionToken) query.push(['X-Amz-Security-Token', config.sessionToken]);

  // 正規クエリ：名前と値をエンコードしてから、エンコード後の名前で並べる
  const canonicalQuery = query
    .map(([k, v]) => [uriEncode(k), uriEncode(v)] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');

  const canonicalPath = `${pathPrefix}/${encodeKey(key)}`;
  // 値の前後の空白は落とし、中の連続した空白は1つにまとめる決まり
  const canonicalHeaders = signed.map(([k, v]) => `${k}:${v.trim().replace(/\s+/g, ' ')}\n`).join('');
  const canonicalRequest = [method, canonicalPath, canonicalQuery, canonicalHeaders, signedNames, 'UNSIGNED-PAYLOAD'].join('\n');
  const stringToSign = [ALGORITHM, dateTime, scope, sha256(canonicalRequest)].join('\n');
  const signature = hmac(signingKey(config.secretAccessKey, date, config.region), stringToSign).toString('hex');

  return `${origin}${canonicalPath}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}
