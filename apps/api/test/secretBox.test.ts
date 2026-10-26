// 内緒の値の包み方。
//
// 守りたいのは「DB の中身だけが漏れる」場合（バックアップの置き間違い、
// 読み取り用の複製、調査で引いた結果が手元に残る、DB の台だけの乗っ取り）。
// 鍵はアプリ側（環境変数）にあるので、DB だけでは開けない。
// 理由と、クラウドの鍵管理を使わない判断は apps/api/src/crypto/secretBox.ts の冒頭。

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  AesSecretBox, generateKey, isSealed, plainBox, sealedWith, SecretError, secretBoxFromEnv,
} from '../src/crypto/secretBox.ts';

const k1 = generateKey();
const k2 = generateKey();
const env = (over: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  MISENARE_SECRET_KEYS: `k1:${k1},k2:${k2}`, ...over,
});

describe('内緒の値を包む', () => {
  it('包んで、開ける', () => {
    const box = secretBoxFromEnv(env({ MISENARE_SECRET_KEY_ID: 'k1' }));
    const sealed = box.seal('とても内緒', 'sso_providers.client_secret:abc');
    assert.ok(isSealed(sealed));
    assert.ok(!sealed.includes('とても内緒'), '中身がそのまま見えている');
    assert.equal(box.open(sealed, 'sso_providers.client_secret:abc'), 'とても内緒');
  });

  it('同じ値でも、包むたびに違う形になる', () => {
    const box = secretBoxFromEnv(env());
    const a = box.seal('おなじ', 'x');
    const b = box.seal('おなじ', 'x');
    assert.notEqual(a, b, '同じ形になると、同じ値が入っていることが外から分かる');
  });

  it('**他の行に貼り替えても開けない**', () => {
    // DB に書ける人が「他社の設定を自社に持ってくる」手口を止める
    const box = secretBoxFromEnv(env());
    const sealed = box.seal('A社の鍵', 'sso_providers.client_secret:A社の行');
    assert.throws(() => box.open(sealed, 'sso_providers.client_secret:B社の行'), SecretError);
  });

  it('1文字でも書き換えられたら開けない', () => {
    const box = secretBoxFromEnv(env());
    const sealed = box.seal('とても内緒', 'x');
    const parts = sealed.split(':');
    // 中身の最後の1文字を変える
    const body = parts[5]!;
    parts[5] = body.slice(0, -1) + (body.at(-1) === 'A' ? 'B' : 'A');
    assert.throws(() => box.open(parts.join(':'), 'x'), SecretError);
  });

  it('別の鍵では開けない', () => {
    const mine = secretBoxFromEnv({ MISENARE_SECRET_KEYS: `k1:${k1}` });
    const other = secretBoxFromEnv({ MISENARE_SECRET_KEYS: `k1:${generateKey()}` });
    const sealed = mine.seal('とても内緒', 'x');
    assert.throws(() => other.open(sealed, 'x'), SecretError);
  });

  it('包んだ鍵が一覧に無ければ、はっきり言う', () => {
    const mine = secretBoxFromEnv({ MISENARE_SECRET_KEYS: `k1:${k1}` });
    const sealed = mine.seal('とても内緒', 'x');
    const without = secretBoxFromEnv({ MISENARE_SECRET_KEYS: `k9:${k2}` });
    assert.throws(() => without.open(sealed, 'x'), /包んだ鍵（k1）が見つかりません/);
  });
});

describe('鍵の入れ替え', () => {
  it('古い鍵で開けて、新しい鍵で包み直せる（止めずに替えられる）', () => {
    // 1. k1 だけのときに包んだ値
    const old = secretBoxFromEnv({ MISENARE_SECRET_KEYS: `k1:${k1}` });
    const sealed = old.seal('とても内緒', 'x');
    assert.equal(sealedWith(sealed), 'k1');

    // 2. k2 を足して、これから包むのは k2 にする
    const box = secretBoxFromEnv(env({ MISENARE_SECRET_KEY_ID: 'k2' }));
    // 古い値はまだ開ける
    assert.equal(box.open(sealed, 'x'), 'とても内緒');
    // 包み直すと k2 になる
    const again = box.seal(box.open(sealed, 'x'), 'x');
    assert.equal(sealedWith(again), 'k2');

    // 3. k1 を外しても、包み直したものは開ける
    const after = secretBoxFromEnv({ MISENARE_SECRET_KEYS: `k2:${k2}` });
    assert.equal(after.open(again, 'x'), 'とても内緒');
    assert.throws(() => after.open(sealed, 'x'), /包んだ鍵（k1）が見つかりません/);
  });

  it('包むのに使う鍵を決めなければ、並びの最後を使う', () => {
    const box = secretBoxFromEnv(env());
    assert.equal(box.keyId, 'k2');
  });
});

describe('鍵を決めていないとき', () => {
  it('包まずに通す（古い動きのまま）', () => {
    const box = secretBoxFromEnv({});
    assert.equal(box.configured, false);
    assert.equal(box.seal('とても内緒', 'x'), 'とても内緒');
    assert.equal(box.open('とても内緒', 'x'), 'とても内緒');
  });

  it('包まれた値は開けないと、はっきり言う（黙って壊さない）', () => {
    const sealed = secretBoxFromEnv(env()).seal('とても内緒', 'x');
    assert.throws(() => plainBox.open(sealed, 'x'), /鍵がありません/);
  });

  it('包む前に入れた値は、鍵を決めてからもそのまま読める', () => {
    const box = secretBoxFromEnv(env());
    assert.equal(box.open('むかし入れた平の値', 'x'), 'むかし入れた平の値');
  });
});

describe('鍵の形', () => {
  it('長さが違う鍵を断る', () => {
    assert.throws(() => secretBoxFromEnv({ MISENARE_SECRET_KEYS: 'k1:bXkta2V5' }), /長さが違います/);
  });

  it('名前の付いていない鍵を断る', () => {
    assert.throws(() => secretBoxFromEnv({ MISENARE_SECRET_KEYS: k1 }), /形が違います/);
  });

  it('一覧に無い鍵を指していたら断る', () => {
    assert.throws(
      () => secretBoxFromEnv(env({ MISENARE_SECRET_KEY_ID: 'k9' })),
      /鍵の一覧にありません/,
    );
  });

  it('作った鍵は、そのまま使える長さで出る', () => {
    const key = generateKey();
    assert.equal(Buffer.from(key, 'base64').length, 32);
    assert.ok(new AesSecretBox(new Map([['k', Buffer.from(key, 'base64')]]), 'k').seal('x', 'y'));
  });
});
