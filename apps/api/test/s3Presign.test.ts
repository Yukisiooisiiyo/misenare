// S3 の署名付きURL。**置いてよい形式を署名に焼き込んでいること**を確かめる。
//
// なぜここが大事か：写真を S3 に置く構成では、中身がサーバーを通らない。
// つまり、こちらで先頭を見て「本当に写真か」を確かめられない。
// S3 は送られてきた Content-Type をそのまま覚えて、読むときもそのまま返し、
// しかも S3 の答えには nosniff が付かない。
// 署名に形式を入れていないと、端末が text/html で上げて、
// **会社のドメインの下に好きな中身を置ける**ことになる。
//
// 署名そのものが AWS に通るかは、ここでは確かめられない（本物に当てるしかない）。
// 確かめるのは「署名の材料に content-type が入っていること」と、
// 「形式を変えると署名が変わること」。後者が成り立てば、
// 違う形式で送られたリクエストは S3 側で弾かれる。

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { presignS3, type S3Config } from '../src/storage/s3.ts';
import { S3Storage } from '../src/storage/storage.ts';

const config: S3Config = {
  bucket: 'misenare-photos',
  region: 'ap-northeast-1',
  accessKeyId: 'AKIAEXAMPLE',
  secretAccessKey: 'ひみつ',
};
const now = new Date('2026-10-26T12:00:00Z');
const opts = { expiresIn: 600, now };

describe('S3 の署名付きURL', () => {
  it('形式を署名に入れると、署名するヘッダーの一覧に出る', () => {
    const without = new URL(presignS3(config, 'PUT', 'a/b.jpg', opts));
    const withType = new URL(presignS3(config, 'PUT', 'a/b.jpg', { ...opts, contentType: 'image/jpeg' }));
    assert.equal(without.searchParams.get('X-Amz-SignedHeaders'), 'host');
    assert.equal(withType.searchParams.get('X-Amz-SignedHeaders'), 'content-type;host');
  });

  it('**形式が違えば署名も違う**（違う形式で送れば S3 が断る）', () => {
    const jpeg = new URL(presignS3(config, 'PUT', 'a/b.jpg', { ...opts, contentType: 'image/jpeg' }));
    const html = new URL(presignS3(config, 'PUT', 'a/b.jpg', { ...opts, contentType: 'text/html' }));
    assert.notEqual(
      jpeg.searchParams.get('X-Amz-Signature'),
      html.searchParams.get('X-Amz-Signature'),
      '形式を変えても署名が同じ＝端末が好きな形式で上げられる',
    );
  });

  it('写真の送り先は、必ず形式を焼き込んで作る', () => {
    const storage = new S3Storage(config, () => now);
    const plan = storage.presignPut('t/k/p.jpg', 'image/jpeg');
    const url = new URL(plan.url);
    assert.equal(url.searchParams.get('X-Amz-SignedHeaders'), 'content-type;host');
    assert.equal(plan.headers['content-type'], 'image/jpeg');
    // 送るヘッダーと、署名に入れた形式が食い違っていたら、S3 が断る＝動かないので気づける
  });

  it('読むときは形式を入れない（保存してある形式がそのまま返る）', () => {
    const storage = new S3Storage(config, () => now);
    const url = new URL(storage.presignGet('t/k/p.jpg'));
    assert.equal(url.searchParams.get('X-Amz-SignedHeaders'), 'host');
  });

  it('同じ材料なら、同じ署名になる（作るたびに変わらない）', () => {
    const a = presignS3(config, 'PUT', 'a/b.jpg', { ...opts, contentType: 'image/png' });
    const b = presignS3(config, 'PUT', 'a/b.jpg', { ...opts, contentType: 'image/png' });
    assert.equal(a, b);
  });

  it('鍵の中の記号は、URL の形に直して入れる', () => {
    // 会社IDとナレッジIDを並べた鍵（/ を含む）がそのまま使える
    const url = presignS3(config, 'GET', '10000000-0000-0000-0000-000000000001/k/p.jpg', opts);
    assert.ok(url.includes('/10000000-0000-0000-0000-000000000001/k/p.jpg?'), url);
  });
});
