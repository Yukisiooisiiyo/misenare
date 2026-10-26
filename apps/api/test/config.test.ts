// 設定の点検。**抜けたまま動いてしまうのが一番こわい**ので、起動の前に言う。
//
// ここで確かめたいのは「何を止めて、何を警告にとどめるか」。
// 止めすぎると出すのが怖くなって古い版が動き続けるので、
// 止めるのは黙って壊れるものだけにしている。

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkConfig } from '../src/config.ts';

const base = { DATABASE_URL: 'postgresql://localhost/x' } as NodeJS.ProcessEnv;
const prod = (over: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  ...base,
  NODE_ENV: 'production',
  APP_URL: 'https://misenare.example.com',
  METRICS_TOKEN: 'あいことば',
  ...over,
});
const keys = (env: NodeJS.ProcessEnv, level?: string): string[] =>
  checkConfig(env).findings.filter((f) => level === undefined || f.level === level).map((f) => f.key);

describe('設定の点検', () => {
  it('接続先が無ければ起動しない', () => {
    const r = checkConfig({});
    assert.ok(r.fatal);
    assert.ok(keys({}, 'error').includes('DATABASE_URL'));
  });

  it('本番で開発用の認証は止める（ヘッダーだけで誰にでもなれる）', () => {
    const r = checkConfig(prod({ MISENARE_DEV_AUTH: '1' }));
    assert.ok(r.fatal);
    assert.ok(keys(prod({ MISENARE_DEV_AUTH: '1' }), 'error').includes('MISENARE_DEV_AUTH'));
    // 手元では警告にとどめる（開発では使う）
    const dev = checkConfig({ ...base, MISENARE_DEV_AUTH: '1' });
    assert.equal(dev.findings.find((f) => f.key === 'MISENARE_DEV_AUTH')?.level, 'warn');
  });

  it('本番で招待リンクの宛先と /metrics の合言葉が無ければ止める', () => {
    const missing = { ...base, NODE_ENV: 'production' } as NodeJS.ProcessEnv;
    assert.ok(keys(missing, 'error').includes('APP_URL'));
    assert.ok(keys(missing, 'error').includes('METRICS_TOKEN'));
    // 手元では警告（localhost のまま動かせる）
    assert.equal(checkConfig(base).fatal, false);
  });

  it('本番の宛先が https でなければ止める（パスキーが動かない）', () => {
    assert.ok(keys(prod({ APP_URL: 'http://misenare.example.com' }), 'error').includes('APP_URL'));
  });

  it('設定が揃っていれば、起動を止めない', () => {
    const r = checkConfig(prod());
    assert.equal(r.fatal, false, r.findings.map((f) => `${f.level} ${f.key}`).join(' / '));
  });
});

describe('入口の設定', () => {
  it('決めなければ、その入口が閉じているだけ（止めない）', () => {
    const r = checkConfig(prod());
    assert.equal(r.fatal, false);
    const info = checkConfig(prod()).findings.filter((f) => f.level === 'info').map((f) => f.key);
    assert.ok(info.includes('WEBAUTHN_RP_ID'));
    assert.ok(info.includes('SSO_REDIRECT_URI'));
  });

  it('パスキーのドメインに URL を入れたら止める', () => {
    assert.ok(keys(prod({ WEBAUTHN_RP_ID: 'https://misenare.example.com' }), 'error').includes('WEBAUTHN_RP_ID'));
  });

  it('出どころがパスキーのドメインと合っていなければ止める（端末が断る）', () => {
    const bad = prod({
      WEBAUTHN_RP_ID: 'misenare.example.com',
      WEBAUTHN_ORIGINS: 'https://misenare.example.com,https://べつのサイト.example.org',
    });
    assert.ok(keys(bad, 'error').includes('WEBAUTHN_ORIGINS'));
    // 下位のドメインは通す（app.misenare.example.com など）
    const okay = prod({
      WEBAUTHN_RP_ID: 'misenare.example.com',
      WEBAUTHN_ORIGINS: 'https://app.misenare.example.com',
    });
    assert.equal(checkConfig(okay).fatal, false);
  });

  it('招待リンクの宛先とパスキーのドメインが食い違っていたら警告する', () => {
    const env = prod({ APP_URL: 'https://misenare.example.com', WEBAUTHN_RP_ID: 'ほかのドメイン.example.org' });
    assert.ok(keys(env, 'warn').includes('WEBAUTHN_RP_ID'));
  });

  it('SSO の戻り先は、経路が違えば警告する（相手に登録した値と合わないと弾かれる）', () => {
    const env = prod({ SSO_REDIRECT_URI: 'https://misenare.example.com/api/auth/callback' });
    assert.ok(keys(env, 'warn').includes('SSO_REDIRECT_URI'));
    const okay = prod({ SSO_REDIRECT_URI: 'https://misenare.example.com/api/auth/sso/callback' });
    assert.equal(checkConfig(okay).findings.some((f) => f.key === 'SSO_REDIRECT_URI' && f.level !== 'info'), false);
  });

  it('本番の SSO の戻り先が https でなければ止める', () => {
    assert.ok(keys(prod({ SSO_REDIRECT_URI: 'http://misenare.example.com/api/auth/sso/callback' }), 'error')
      .includes('SSO_REDIRECT_URI'));
  });
});

describe('メールの設定', () => {
  it('決めなければ、知らせが届かないことだけ言う（止めない）', () => {
    const r = checkConfig(prod());
    assert.equal(r.fatal, false);
    assert.ok(checkConfig(prod()).findings.some((f) => f.key === 'SMTP_HOST' && f.level === 'warn'));
  });

  it('差出人の形が違えば止める', () => {
    const env = prod({ SMTP_HOST: 'smtp.example.com', MAIL_FROM: 'ただの文字' });
    assert.ok(keys(env, 'error').includes('MAIL_FROM'));
  });

  it('25 番は警告する（暗号化できないことが多い）', () => {
    const env = prod({ SMTP_HOST: 'smtp.example.com', MAIL_FROM: 'a@example.com', SMTP_PORT: '25' });
    assert.ok(keys(env, 'warn').includes('SMTP_PORT'));
    // 明示して許しているなら言わない
    const allowed = prod({ ...env, SMTP_ALLOW_PLAINTEXT: '1' });
    assert.ok(!keys(allowed, 'warn').includes('SMTP_PORT'));
  });

  it('暗号化しない送信を許していたら、本番では警告する', () => {
    const env = prod({ SMTP_HOST: 'smtp.example.com', MAIL_FROM: 'a@example.com', SMTP_ALLOW_PLAINTEXT: '1' });
    assert.ok(keys(env, 'warn').includes('SMTP_ALLOW_PLAINTEXT'));
  });

  it('合言葉だけ忘れていたら警告する', () => {
    const env = prod({ SMTP_HOST: 'smtp.example.com', MAIL_FROM: 'a@example.com', SMTP_USER: 'u' });
    assert.ok(keys(env, 'warn').includes('SMTP_PASS'));
  });

  it('揃っていれば、何も言わない', () => {
    const env = prod({ SMTP_HOST: 'smtp.example.com', MAIL_FROM: 'misenare@example.com', SMTP_USER: 'u', SMTP_PASS: 'p' });
    assert.equal(checkConfig(env).findings.some((f) => f.key.startsWith('SMTP') || f.key === 'MAIL_FROM'), false);
  });
});

describe('内緒の値を包む鍵', () => {
  const key = () => Buffer.from(Array.from({ length: 32 }, (_, i) => i)).toString('base64');

  it('決めていなければ、本番では警告する（止めない）', () => {
    assert.ok(keys(prod(), 'warn').includes('MISENARE_SECRET_KEYS'));
    assert.equal(checkConfig(prod()).fatal, false);
  });

  it('長さや形が違えば止める', () => {
    assert.ok(keys(prod({ MISENARE_SECRET_KEYS: 'k1:bXkta2V5' }), 'error').includes('MISENARE_SECRET_KEYS'));
    assert.ok(keys(prod({ MISENARE_SECRET_KEYS: key() }), 'error').includes('MISENARE_SECRET_KEYS'));
  });

  it('名前が重なっていたら止める（どの鍵で包んだか分からなくなる）', () => {
    const env = prod({ MISENARE_SECRET_KEYS: `k1:${key()},k1:${key()}` });
    assert.ok(keys(env, 'error').includes('MISENARE_SECRET_KEYS'));
  });

  it('一覧に無い鍵を指していたら止める', () => {
    const env = prod({ MISENARE_SECRET_KEYS: `k1:${key()}`, MISENARE_SECRET_KEY_ID: 'k9' });
    assert.ok(keys(env, 'error').includes('MISENARE_SECRET_KEY_ID'));
  });

  it('鍵が複数あってどれで包むか決めていなければ、警告する', () => {
    const env = prod({ MISENARE_SECRET_KEYS: `k1:${key()},k2:${key()}` });
    assert.ok(keys(env, 'warn').includes('MISENARE_SECRET_KEY_ID'));
  });

  it('1本だけ決めていれば、何も言わない', () => {
    const env = prod({ MISENARE_SECRET_KEYS: `k1:${key()}` });
    assert.equal(checkConfig(env).findings.some((f) => f.key.startsWith('MISENARE_SECRET')), false);
  });
});
