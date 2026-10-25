// 写真の保存先。ローカルのディレクトリと S3 を同じ形で扱う。
//
// 置き場所によって、端末からの送り方が変わる：
//   ローカル … API が中身を受け取って、ディレクトリに書く
//   S3      … API は署名付きURLだけを返し、中身は端末から直接 S3 に上がる（API を通らない）

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, normalize, resolve, sep } from 'node:path';
import { presignS3, type S3Config } from './s3.ts';

export interface Presigned {
  url: string;
  headers: Record<string, string>;
}

export interface Storage {
  /**
   * 端末から直接送るための署名付きURL。
   * 作れない保存先（ローカル）は null を返す。その場合は API が中身を受け取る。
   */
  presignPut(key: string, contentType: string): Presigned | null;
  /** 閲覧用の署名付きURL。作れない保存先は null（API が中身を返す） */
  presignGet(key: string): string | null;
  /** 中身を保存する（署名付きURLを使わない保存先向け） */
  put(key: string, body: Uint8Array, contentType: string): Promise<void>;
  /** 中身を読む（署名付きURLを使わない保存先向け） */
  get(key: string): Promise<Uint8Array>;
  remove(key: string): Promise<void>;
}

/** 開発と小さな構成向け。中身はサーバーのディスクに置く */
export class LocalStorage implements Storage {
  constructor(private readonly root: string) {}

  presignPut(): null { return null; }
  presignGet(): null { return null; }

  /** 保存先のパス。キーに `..` などが混ざっても root の外には出さない */
  private pathOf(key: string): string {
    const full = resolve(this.root, normalize(key));
    const root = resolve(this.root);
    if (full !== root && !full.startsWith(root + sep)) throw new Error(`invalid key: ${key}`);
    return full;
  }

  async put(key: string, body: Uint8Array, _contentType?: string): Promise<void> {
    const path = this.pathOf(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body);
  }

  async get(key: string): Promise<Uint8Array> {
    return new Uint8Array(await readFile(this.pathOf(key)));
  }

  async remove(key: string): Promise<void> {
    await rm(this.pathOf(key), { force: true });
  }
}

/** S3（互換ストレージを含む）。中身は端末と S3 が直接やり取りし、API は署名だけを作る */
export class S3Storage implements Storage {
  /** 署名付きURLの有効時間（秒）。送信にも閲覧にも使う */
  static readonly EXPIRES_IN = 10 * 60;

  constructor(private readonly config: S3Config, private readonly now: () => Date = () => new Date()) {}

  presignPut(key: string, contentType: string): Presigned {
    return {
      url: presignS3(this.config, 'PUT', key, { expiresIn: S3Storage.EXPIRES_IN, now: this.now() }),
      // Content-Type は署名に含めない（含めると端末側の送り方の違いで署名が合わなくなる）。
      // S3 はこのヘッダーの値をそのまま保存する。
      headers: { 'content-type': contentType },
    };
  }

  presignGet(key: string): string {
    return presignS3(this.config, 'GET', key, { expiresIn: S3Storage.EXPIRES_IN, now: this.now() });
  }

  async put(): Promise<void> { throw new Error('S3 へは端末から直接送ります'); }
  async get(): Promise<Uint8Array> { throw new Error('S3 からは署名付きURLで読みます'); }

  async remove(key: string): Promise<void> {
    const res = await fetch(presignS3(this.config, 'DELETE', key, { expiresIn: 60, now: this.now() }), { method: 'DELETE' });
    if (!res.ok && res.status !== 404) throw new Error(`S3 の削除に失敗しました（${res.status}）`);
  }
}

/** 環境変数から保存先を決める。S3 の設定がなければローカル保存 */
export function storageFromEnv(env: NodeJS.ProcessEnv = process.env): Storage {
  const bucket = env.S3_BUCKET;
  if (!bucket) return new LocalStorage(env.PHOTO_DIR ?? join(process.cwd(), 'var', 'photos'));
  const accessKeyId = env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = env.AWS_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) throw new Error('S3_BUCKET を設定したら AWS_ACCESS_KEY_ID と AWS_SECRET_ACCESS_KEY も必要です');
  return new S3Storage({
    bucket,
    region: env.AWS_REGION ?? 'ap-northeast-1',
    accessKeyId,
    secretAccessKey,
    ...(env.AWS_SESSION_TOKEN ? { sessionToken: env.AWS_SESSION_TOKEN } : {}),
    ...(env.S3_ENDPOINT ? { endpoint: env.S3_ENDPOINT } : {}),
  });
}
