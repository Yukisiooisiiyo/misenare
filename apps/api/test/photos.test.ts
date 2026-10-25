import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createKnowledge, approveVersion } from '../src/domain/knowledge.ts';
import {
  deletePhoto,
  finishPhotoUpload,
  listPhotos,
  MAX_PHOTO_BYTES,
  openPhoto,
  receivePhoto,
  startPhotoUpload,
  sweepAbandonedPhotos,
} from '../src/domain/photos.ts';
import { LocalStorage, S3Storage, storageFromEnv } from '../src/storage/storage.ts';
import { presignS3, signingKey, uriEncode } from '../src/storage/s3.ts';
import { freshDatabase, manager, storeBStaff, STORE_A, T, tokenizer, trusted, visitor } from './helpers.ts';
import type { TestDatabase } from './helpers.ts';
import type { Actor } from '../src/domain/actor.ts';

let db: TestDatabase;
let storage: LocalStorage;
let dir: string;

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);

/** 本店のもう一人の visitor（書いた本人でも承認者でもない人） */
const otherVisitor: Actor = { userId: '40000000-0000-0000-0000-00000000000a', tenantId: T, storeIds: [STORE_A], trustLevel: 'visitor', adminScope: 'none' };

before(async () => {
  db = await freshDatabase();
  dir = await mkdtemp(join(tmpdir(), 'misenare-photos-'));
  storage = new LocalStorage(dir);
  await db.withTenant(T, async (q) => {
    await q.query(`INSERT INTO users (id, tenant_id, name, trust_level, admin_scope) VALUES ($1, $2, 'もう一人の新人', 'visitor', 'none')`, [otherVisitor.userId, T]);
    await q.query(`INSERT INTO memberships (tenant_id, user_id, store_id) VALUES ($1, $2, $3)`, [T, otherVisitor.userId, STORE_A]);
  });
});
after(async () => { await db.close(); });

/** 公開済みのナレッジを1件作る */
async function published(title = '写真つきのメモ'): Promise<string> {
  return db.withTenant(T, async (q) => {
    const k = await createKnowledge(q, tokenizer, trusted, { storeId: STORE_A, title, body: '本文', tagNames: ['#写真'] });
    return k.id;
  });
}

/** 1枚まるごと上げる */
async function upload(knowledgeId: string, actor = trusted, body = JPEG): Promise<string> {
  return db.withTenant(T, async (q) => {
    const plan = await startPhotoUpload(q, storage, actor, knowledgeId, { contentType: 'image/jpeg', bytes: body.byteLength });
    await receivePhoto(q, storage, actor, plan.photoId, body, 'image/jpeg');
    await finishPhotoUpload(q, storage, actor, plan.photoId);
    return plan.photoId;
  });
}

describe('写真', () => {
  it('ローカル保存では API が中身を受け取り、閲覧でそのまま返す', async () => {
    const id = await published();
    const photoId = await upload(id);
    await db.withTenant(T, async (q) => {
      const photos = await listPhotos(q, storage, trusted, id);
      assert.equal(photos.length, 1);
      assert.equal(photos[0]!.id, photoId);
      assert.equal(photos[0]!.url, `/photos/${photoId}/data`, '署名付きURLを作れない保存先では API のパスを返す');
      assert.equal(photos[0]!.bytes, JPEG.byteLength);
      assert.equal(photos[0]!.createdBy, 'ベテランパート');
      const open = await openPhoto(q, storage, trusted, photoId);
      assert.equal(open.kind, 'body');
      assert.deepEqual(open.kind === 'body' ? open.body : null, JPEG);
    });
    // 中身は会社・ナレッジごとのディレクトリに分かれて置かれる
    const onDisk = await readFile(join(dir, T, id, `${photoId}.jpg`));
    assert.deepEqual(new Uint8Array(onDisk), JPEG);
  });

  it('送り終わるまでは一覧に出ない', async () => {
    const id = await published('まだ送っていない');
    await db.withTenant(T, async (q) => {
      const plan = await startPhotoUpload(q, storage, trusted, id, { contentType: 'image/jpeg', bytes: 8 });
      assert.equal(plan.withSession, true, 'ローカル保存のときは API にログインの印を付けて送る');
      assert.equal((await listPhotos(q, storage, trusted, id)).length, 0);
      await receivePhoto(q, storage, trusted, plan.photoId, JPEG, 'image/jpeg');
      assert.equal((await listPhotos(q, storage, trusted, id)).length, 0, '中身が届いただけではまだ出さない');
      await finishPhotoUpload(q, storage, trusted, plan.photoId, 'キャプション');
      const photos = await listPhotos(q, storage, trusted, id);
      assert.equal(photos.length, 1);
      assert.equal(photos[0]!.caption, 'キャプション');
    });
  });

  it('形式と大きさ、枚数の上限を守らせる', async () => {
    const id = await published('上限の確認');
    await db.withTenant(T, async (q) => {
      await assert.rejects(startPhotoUpload(q, storage, trusted, id, { contentType: 'application/pdf', bytes: 10 }), /JPEG/);
      await assert.rejects(startPhotoUpload(q, storage, trusted, id, { contentType: 'image/jpeg', bytes: MAX_PHOTO_BYTES + 1 }), /大きすぎます/);
      await assert.rejects(startPhotoUpload(q, storage, trusted, id, { contentType: 'image/jpeg', bytes: 0 }), /大きすぎます/);
      // 申告より大きい中身を送ってきても、上限で止める
      const plan = await startPhotoUpload(q, storage, trusted, id, { contentType: 'image/jpeg', bytes: 10 });
      await assert.rejects(receivePhoto(q, storage, trusted, plan.photoId, new Uint8Array(MAX_PHOTO_BYTES + 1), 'image/jpeg'), /大きすぎます/);
      await assert.rejects(receivePhoto(q, storage, trusted, plan.photoId, JPEG, 'image/png'), /形式/);
    });
  });

  it('他店舗の人は、見ることも付けることもできない', async () => {
    const id = await published('よその店には見せない');
    const photoId = await upload(id);
    await db.withTenant(T, async (q) => {
      await assert.rejects(listPhotos(q, storage, storeBStaff, id), /閲覧できません/);
      await assert.rejects(openPhoto(q, storage, storeBStaff, photoId), /閲覧できません/);
      await assert.rejects(startPhotoUpload(q, storage, storeBStaff, id, { contentType: 'image/jpeg', bytes: 8 }), /閲覧できません/);
      await assert.rejects(deletePhoto(q, storage, storeBStaff, photoId), /消せません/);
    });
  });

  it('未公開のナレッジの写真は、書いた人と承認できる人だけが見られる', async () => {
    const id = await db.withTenant(T, async (q) => {
      const k = await createKnowledge(q, tokenizer, visitor, { storeId: STORE_A, title: '承認待ち', body: '本文', tagNames: ['#写真'] });
      assert.equal(k.published, false);
      return k.id;
    });
    const photoId = await upload(id, visitor);
    await db.withTenant(T, async (q) => {
      assert.equal((await listPhotos(q, storage, visitor, id)).length, 1, '書いた本人は見られる');
      assert.equal((await listPhotos(q, storage, manager, id)).length, 1, '承認できる人は見られる');
      assert.equal((await listPhotos(q, storage, trusted, id)).length, 1, 'trusted は承認する側なので見られる');
      // 書いてもいない、承認もできない人には見せない
      await assert.rejects(listPhotos(q, storage, otherVisitor, id), /公開されていません/);
      await assert.rejects(openPhoto(q, storage, otherVisitor, photoId), /公開されていません/);
      // 公開されれば、同じ店舗の人は誰でも見られる
      await approveVersion(q, tokenizer, manager, id, 1);
      assert.equal((await listPhotos(q, storage, otherVisitor, id)).length, 1);
    });
  });

  it('消せるのは付けた本人と承認できる人だけで、中身も消える', async () => {
    const id = await published('消す練習');
    const mine = await upload(id, visitor);
    const others = await upload(id, trusted);
    await db.withTenant(T, async (q) => {
      await assert.rejects(deletePhoto(q, storage, visitor, others), /消せません/);
      await deletePhoto(q, storage, visitor, mine);
      await deletePhoto(q, storage, manager, others);
      assert.equal((await listPhotos(q, storage, trusted, id)).length, 0);
    });
    await assert.rejects(readFile(join(dir, T, id, `${mine}.jpg`)), /ENOENT/);
  });

  it('送りかけのまま残った写真は、夜間バッチが片付ける', async () => {
    const id = await published('片付けの確認');
    await db.withTenant(T, async (q) => {
      const plan = await startPhotoUpload(q, storage, trusted, id, { contentType: 'image/jpeg', bytes: 8 });
      await receivePhoto(q, storage, trusted, plan.photoId, JPEG, 'image/jpeg');
      assert.equal(await sweepAbandonedPhotos(q, storage), 0, '新しいものは片付けない');
      await q.query(`UPDATE knowledge_photos SET created_at = now() - interval '2 days' WHERE id = $1`, [plan.photoId]);
      assert.equal(await sweepAbandonedPhotos(q, storage), 1);
      await assert.rejects(readFile(join(dir, T, id, `${plan.photoId}.jpg`)), /ENOENT/);
    });
  });

  it('ナレッジを消すと写真も消える（外部キー）', async () => {
    const id = await published('一緒に消える');
    const photoId = await upload(id);
    await db.withTenant(T, async (q) => {
      await q.query(`DELETE FROM knowledge WHERE id = $1`, [id]);
      const rows = await q.query(`SELECT 1 FROM knowledge_photos WHERE id = $1`, [photoId]);
      assert.equal(rows.length, 0);
    });
  });

  it('保存先のキーに `..` が混ざっても、ディレクトリの外には書かない', async () => {
    await assert.rejects(storage.put('../逃げ出す.jpg', JPEG, 'image/jpeg'), /invalid key/);
    await assert.rejects(storage.get('../../etc/passwd'), /invalid key/);
  });
});

describe('S3 の署名付きURL', () => {
  const config = {
    bucket: 'examplebucket',
    region: 'us-east-1',
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
  };

  it('署名鍵の導出が AWS の例と一致する', () => {
    // AWS ドキュメント「署名鍵の導出」の例（Signature Version 4）
    assert.equal(
      signingKey('wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', '20150830', 'us-east-1', 'iam').toString('hex'),
      'c4afb1cc5771d871763a393e44b703571b55cc28424d1a5e86da6ed3c154a4b9',
    );
  });

  // 以下の署名は、独立した実装（npm の aws4）と突き合わせて一致を確認した値。
  // 署名の作り方を変えたときに、ここが変わっていないかで確かめる。
  it('署名が既知の値と一致する（日本語・記号・一時認証情報を含む）', () => {
    const sig = (url: string) => new URL(url).searchParams.get('X-Amz-Signature');
    const day = new Date('2013-05-24T00:00:00Z');
    assert.equal(
      sig(presignS3(config, 'GET', 'test.txt', { expiresIn: 86400, now: day })),
      'e88bfc86a6838bda6e6b842bfd69edd8741f6aedb0459e1275be0713ad3e2633',
    );
    assert.equal(
      sig(presignS3({ ...config, region: 'ap-northeast-1' }, 'PUT', 'tenant/abc/写真 1.jpg', { expiresIn: 86400, now: new Date('2026-10-25T16:40:00Z') })),
      '3a6e3c3e613a412fefbb5dbeb29b1551af4f06d2ba1d0b6e97ade2d78897805b',
    );
    assert.equal(
      sig(presignS3({ ...config, region: 'ap-northeast-1' }, 'DELETE', "a/b+c~d(e)!'*/f.png", { expiresIn: 86400, now: new Date('2026-01-02T03:04:05Z') })),
      'e881f51e4e4e58293a0f43beaecec154e060c4256aaf7aca9f0ab374a6103a67',
    );
    assert.equal(
      sig(presignS3({ ...config, bucket: 'b', region: 'ap-northeast-1', sessionToken: 'TOKEN/123+abc' }, 'PUT', 'k.jpg', { expiresIn: 86400, now: new Date('2026-01-02T03:04:05Z') })),
      '129b593b3846d7a0fa4456c5a8853ab79e541de1d143f86d01e8005abf4f7b94',
    );
  });

  it('URL の形が AWS の決まりどおり', () => {
    const url = new URL(presignS3(config, 'PUT', 'a/b c.jpg', { expiresIn: 600, now: new Date('2026-10-25T16:40:00Z') }));
    assert.equal(url.host, 'examplebucket.s3.us-east-1.amazonaws.com');
    assert.equal(url.pathname, '/a/b%20c.jpg', 'スペースは %20（+ ではない）');
    assert.equal(url.searchParams.get('X-Amz-Algorithm'), 'AWS4-HMAC-SHA256');
    assert.equal(url.searchParams.get('X-Amz-Credential'), 'AKIAIOSFODNN7EXAMPLE/20261025/us-east-1/s3/aws4_request');
    assert.equal(url.searchParams.get('X-Amz-Date'), '20261025T164000Z');
    assert.equal(url.searchParams.get('X-Amz-Expires'), '600');
    assert.equal(url.searchParams.get('X-Amz-SignedHeaders'), 'host');
    assert.match(url.searchParams.get('X-Amz-Signature') ?? '', /^[0-9a-f]{64}$/);
    // AWS は `!'()*` もエンコードする
    assert.equal(uriEncode("a!'()*b"), 'a%21%27%28%29%2Ab');
  });

  it('鍵・時刻・メソッド・キーのどれが変わっても署名が変わる', () => {
    const base = { expiresIn: 600, now: new Date('2026-10-25T16:40:00Z') };
    const sig = (url: string) => new URL(url).searchParams.get('X-Amz-Signature');
    const first = sig(presignS3(config, 'PUT', 'a.jpg', base));
    assert.notEqual(first, sig(presignS3(config, 'GET', 'a.jpg', base)));
    assert.notEqual(first, sig(presignS3(config, 'PUT', 'b.jpg', base)));
    assert.notEqual(first, sig(presignS3(config, 'PUT', 'a.jpg', { ...base, expiresIn: 601 })));
    assert.notEqual(first, sig(presignS3(config, 'PUT', 'a.jpg', { ...base, now: new Date('2026-10-25T16:40:01Z') })));
    assert.notEqual(first, sig(presignS3({ ...config, secretAccessKey: 'x'.repeat(40) }, 'PUT', 'a.jpg', base)));
  });

  it('S3 互換ストレージはパス形式で署名する', () => {
    const url = new URL(presignS3({ ...config, endpoint: 'https://s3.example.com' }, 'GET', 'k.jpg', { expiresIn: 60, now: new Date('2026-01-02T03:04:05Z') }));
    assert.equal(url.host, 's3.example.com');
    assert.equal(url.pathname, '/examplebucket/k.jpg');
  });

  it('S3 を使うときは、閲覧も送信も署名付きURLになる', () => {
    const s3 = new S3Storage(config, () => new Date('2026-10-25T16:40:00Z'));
    const put = s3.presignPut('k.jpg', 'image/jpeg');
    assert.match(put.url, /^https:\/\/examplebucket\.s3\.us-east-1\.amazonaws\.com\/k\.jpg\?/);
    assert.equal(put.headers['content-type'], 'image/jpeg');
    assert.match(s3.presignGet('k.jpg'), /X-Amz-Signature=/);
  });

  it('環境変数から保存先を決める', () => {
    assert.ok(storageFromEnv({ PHOTO_DIR: dir } as NodeJS.ProcessEnv) instanceof LocalStorage);
    const s3 = storageFromEnv({ S3_BUCKET: 'b', AWS_REGION: 'ap-northeast-1', AWS_ACCESS_KEY_ID: 'k', AWS_SECRET_ACCESS_KEY: 's' } as NodeJS.ProcessEnv);
    assert.ok(s3 instanceof S3Storage);
    assert.throws(() => storageFromEnv({ S3_BUCKET: 'b' } as NodeJS.ProcessEnv), /AWS_ACCESS_KEY_ID/);
  });
});

describe('写真の API', () => {
  let app: (req: Request) => Promise<Response>;

  before(async () => {
    const { createApp } = await import('../src/http/app.ts');
    const { DevHeaderAuthenticator } = await import('../src/http/auth.ts');
    app = createApp({ database: db, auth: new DevHeaderAuthenticator(), tokenizer, storage });
  });

  const headers = (actor: typeof trusted) => ({ 'x-dev-tenant-id': actor.tenantId, 'x-dev-user-id': actor.userId });
  const callJson = async (actor: typeof trusted, method: string, path: string, body?: unknown) => {
    const res = await app(new Request(`http://localhost${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...headers(actor) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }));
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };

  it('申告 → 中身 → 完了 → 閲覧、の一連の流れ', async () => {
    const id = await published('API から写真を付ける');
    const start = await callJson(trusted, 'POST', `/knowledge/${id}/photos`, { contentType: 'image/jpeg', bytes: JPEG.byteLength });
    assert.equal(start.status, 201);
    assert.equal(start.body.url, `/photos/${start.body.photoId}/data`);

    const put = await app(new Request(`http://localhost${start.body.url}`, {
      method: 'PUT', headers: { 'content-type': 'image/jpeg', ...headers(trusted) }, body: JPEG,
    }));
    assert.equal(put.status, 200);

    const done = await callJson(trusted, 'POST', `/photos/${start.body.photoId}/complete`, { caption: '値札の位置' });
    assert.equal(done.status, 201);
    assert.equal(done.body.caption, '値札の位置');

    const list = await callJson(visitor, 'GET', `/knowledge/${id}/photos`);
    assert.equal(list.body.length, 1);

    const shown = await app(new Request(`http://localhost${list.body[0].url}`, { headers: headers(visitor) }));
    assert.equal(shown.status, 200);
    assert.equal(shown.headers.get('content-type'), 'image/jpeg');
    assert.equal(shown.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(new Uint8Array(await shown.arrayBuffer()), JPEG);

    assert.equal((await callJson(trusted, 'DELETE', `/photos/${start.body.photoId}`)).status, 200);
    assert.equal((await callJson(visitor, 'GET', `/knowledge/${id}/photos`)).body.length, 0);
  });

  it('おかしな入力は 400、他店舗からは 403、ログインしていなければ 401', async () => {
    const id = await published('入力の確認');
    assert.equal((await callJson(trusted, 'POST', `/knowledge/${id}/photos`, { contentType: 'image/jpeg' })).status, 400);
    assert.equal((await callJson(trusted, 'POST', `/knowledge/${id}/photos`, { contentType: 'image/gif', bytes: 10 })).status, 400);
    assert.equal((await callJson(storeBStaff, 'POST', `/knowledge/${id}/photos`, { contentType: 'image/jpeg', bytes: 10 })).status, 403);
    assert.equal((await app(new Request(`http://localhost/knowledge/${id}/photos`))).status, 401);
    assert.equal((await callJson(trusted, 'GET', '/photos/not-a-uuid/data')).status, 400);
  });

  it('他人が申告した枠には中身を送れない', async () => {
    const id = await published('横取りの確認');
    const start = await callJson(trusted, 'POST', `/knowledge/${id}/photos`, { contentType: 'image/jpeg', bytes: 8 });
    const put = await app(new Request(`http://localhost${start.body.url}`, {
      method: 'PUT', headers: { 'content-type': 'image/jpeg', ...headers(visitor) }, body: JPEG,
    }));
    assert.equal(put.status, 403);
  });
});
