// 外に取りに行く口の確かめ。**ここが抜けると、こちらのサーバーが社内への入口になる。**
//
// 会社アカウント（OIDC）では、相手の文書が次の行き先を決める。
//   jwks_uri: http://169.254.169.254/latest/meta-data/iam/security-credentials/
// と書かれた文書を返すだけで、クラウドの鍵をこちらが読んで相手に渡してしまう。
// 設定を入れるのは本部の管理者（身内）だが、端末の乗っ取り・相手の IdP の乗っ取り・
// 複数の会社が同じサーバーに乗ることを考えると、身内かどうかとは別に塞ぐ必要がある。

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { describe, it } from 'node:test';
import { FetchRefused, isPublicAddress, requireSafeUrl, resolvePublic, safeFetch } from '../src/auth/safeFetch.ts';

describe('アドレスの判定', () => {
  it('社内・自分自身・クラウドの鍵置き場を断る', () => {
    for (const address of [
      '127.0.0.1', '127.1.2.3',          // 自分自身
      '10.0.0.5', '172.16.0.1', '172.31.255.255', '192.168.1.1', // 社内
      '169.254.169.254',                 // クラウドの鍵置き場（これが本命）
      '100.64.0.1',                      // 事業者の内側
      '0.0.0.0', '224.0.0.1', '255.255.255.255',
      '::1', '::', 'fc00::1', 'fd12::1', 'fe80::1', 'ff02::1',
      '::ffff:127.0.0.1',                // IPv4 を IPv6 の形で書いたもの
      '::ffff:10.0.0.1',
      '2001:db8::1',
    ]) {
      assert.equal(isPublicAddress(address), false, `${address} を通してしまう`);
    }
  });

  it('外から見えるアドレスは通す', () => {
    for (const address of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '2606:4700::1111']) {
      assert.equal(isPublicAddress(address), true, `${address} を断ってしまう`);
    }
  });

  it('アドレスでない文字列は通さない', () => {
    assert.equal(isPublicAddress('localhost'), false);
    assert.equal(isPublicAddress(''), false);
    assert.equal(isPublicAddress('8.8.8'), false);
  });

  it('名前が社内を指していれば断る', async () => {
    // localhost は 127.0.0.1 と ::1 を指す
    await assert.rejects(resolvePublic('localhost'), /外から見えないアドレス/);
    await assert.rejects(resolvePublic('127.0.0.1'), /外から見えないアドレス/);
    await assert.rejects(resolvePublic('169.254.169.254'), /外から見えないアドレス/);
  });
});

describe('URL の形', () => {
  it('https だけを通す', () => {
    assert.ok(requireSafeUrl('https://idp.example.com/x', '行き先'));
    assert.throws(() => requireSafeUrl('http://idp.example.com/x', '行き先'), /https/);
    // file: や gopher: のような、別の仕組みに手を伸ばす形も止まる
    assert.throws(() => requireSafeUrl('file:///etc/passwd', '行き先'), /https/);
    assert.throws(() => requireSafeUrl('gopher://idp.example.com/', '行き先'), /https/);
  });

  it('利用者名や合言葉を埋め込んだ URL を断る', () => {
    // https://evil.example.com@社内のアドレス/ のような、見間違いを誘う形
    assert.throws(() => requireSafeUrl('https://user:pass@idp.example.com/', '行き先'), /利用者名や合言葉/);
  });

  it('形になっていないものを断る', () => {
    assert.throws(() => requireSafeUrl('ただの文字', '行き先'), /形が違います/);
  });
});

describe('取りに行く口', () => {
  it('社内のアドレスには行かない（つなぐ前に止める）', async () => {
    // 本物のサーバーを立てて、**つながらないこと**を確かめる。
    // 立てたサーバーに1回でも届いていたら、塞げていない。
    let reached = 0;
    const server = createServer((_req, res) => { reached++; res.end('ok'); });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    try {
      await assert.rejects(safeFetch({ url: `https://127.0.0.1:${port}/x` }), FetchRefused);
      await assert.rejects(safeFetch({ url: `https://localhost:${port}/x` }), FetchRefused);
      await assert.rejects(safeFetch({ url: `http://127.0.0.1:${port}/x` }), /https/);
      assert.equal(reached, 0, '社内のアドレスに届いてしまった');
    } finally {
      server.close();
    }
  });

  it('クラウドの鍵置き場には行かない', async () => {
    await assert.rejects(
      safeFetch({ url: 'https://169.254.169.254/latest/meta-data/' }),
      /外から見えないアドレス/,
    );
  });
});
