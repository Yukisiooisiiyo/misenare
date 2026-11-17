// 認証アプリの6桁のコード（auth/totp.ts）。RFC 6238 の付録にある値と突き合わせる。

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { base32Decode, base32Encode, matchTotp, newTotpSecret, otpauthUri, totpCode, totpStep } from '../src/auth/totp.ts';

// RFC 6238 の試験用の鍵（ASCII の "12345678901234567890"）
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890', 'ascii'));

describe('認証アプリのコード（TOTP）', () => {
  it('base32 は RFC 4648 の例のとおりで、行って戻る', () => {
    assert.equal(base32Encode(Buffer.from('foobar')), 'MZXW6YTBOI');
    assert.equal(base32Encode(Buffer.from('fo')), 'MZXQ');
    assert.equal(base32Decode('MZXW6YTBOI')!.toString(), 'foobar');
    assert.equal(base32Decode('mzxw 6ytb oi==')!.toString(), 'foobar');
    assert.equal(base32Decode('MZXW6YTB0I'), null); // 0 は base32 に無い
    const secret = newTotpSecret();
    assert.match(secret, /^[A-Z2-7]{32}$/);
    assert.equal(base32Encode(base32Decode(secret)!), secret);
    assert.notEqual(newTotpSecret(), secret);
  });

  it('RFC 6238 の付録の時刻で、同じコードになる（8桁の例の下6桁）', () => {
    const cases: Array<[number, string]> = [
      [59, '287082'], [1111111109, '081804'], [1111111111, '050471'], [1234567890, '005924'], [2000000000, '279037'], [20000000000, '353130'],
    ];
    for (const [seconds, code] of cases) assert.equal(totpCode(RFC_SECRET, totpStep(seconds * 1000)), code, `${seconds} 秒`);
  });

  it('前後30秒までは通し、それより離れたコードは通さない', () => {
    const now = 1_800_000_000_000;
    const step = totpStep(now);
    assert.equal(matchTotp(RFC_SECRET, totpCode(RFC_SECRET, step), now), step);
    assert.equal(matchTotp(RFC_SECRET, totpCode(RFC_SECRET, step - 1), now), step - 1);
    assert.equal(matchTotp(RFC_SECRET, totpCode(RFC_SECRET, step + 1), now), step + 1);
    assert.equal(matchTotp(RFC_SECRET, totpCode(RFC_SECRET, step - 2), now), null);
    assert.equal(matchTotp(RFC_SECRET, totpCode(RFC_SECRET, step + 2), now), null);
  });

  it('一度通した刻みより前のコードは通さない。形の違うものも通さない', () => {
    const now = 1_800_000_000_000;
    const step = totpStep(now);
    const code = totpCode(RFC_SECRET, step);
    assert.equal(matchTotp(RFC_SECRET, code, now, step - 1), step);
    assert.equal(matchTotp(RFC_SECRET, code, now, step), null);
    assert.equal(matchTotp(RFC_SECRET, totpCode(RFC_SECRET, step - 1), now, step), null);
    assert.equal(matchTotp(RFC_SECRET, ` ${code.slice(0, 3)} ${code.slice(3)} `, now), step, '空白は読み飛ばす');
    for (const bad of ['', '12345', '1234567', 'abcdef', `${code}0`]) assert.equal(matchTotp(RFC_SECRET, bad, now), null, bad);
  });

  it('認証アプリに読ませる URI に、鍵と名前が入る', () => {
    const uri = otpauthUri('JBSWY3DPEHPK3PXP', 'owner@tsugigami.example', 'Tsugigami');
    assert.equal(uri, 'otpauth://totp/Tsugigami:owner%40tsugigami.example?secret=JBSWY3DPEHPK3PXP&issuer=Tsugigami&algorithm=SHA1&digits=6&period=30');
  });
});
