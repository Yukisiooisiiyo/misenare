// 起動のときに設定を点検する。
//
// なぜ要るか：**設定の抜けは、抜けたまま動いてしまうのが一番こわい。**
//   METRICS_TOKEN を忘れる     … /metrics が誰でも見られる
//   MISENARE_RATE_SALT を忘れる … 台を増やすと試行回数の数え方がずれる
//   APP_URL を忘れる           … 招待リンクが localhost になり、誰も入れない
//   WEBAUTHN_RP_ID を忘れる    … パスキーの画面が 404 になる（気づくのは利用者）
// どれも例外にはならないので、本番に出してから気づくことになる。
// 起動のたびに、何が足りないかを声に出す。
//
// 止めるのは「黙って壊れる」ものだけにする。足りなくても安全側に倒れるものは
// 警告にとどめる。止めすぎると、出すのが怖くなって古い版が動き続ける。

/**
 * 日付の判断に使うタイムゾーン（MISENARE_TZ、既定は日本時間）。
 * なぜ要るか：PostgreSQL の current_date はサーバーの TZ（Docker の postgres は UTC）で決まり、
 * 日本の店舗では 0:00〜8:59 のあいだ「今日の引き継ぎ」が前日になる。
 * 綴りを間違えると PostgreSQL の set_config が毎回失敗して全リクエストが落ちるので、起動のときに Intl で確かめて止める。
 */
export function appTimeZone(env: NodeJS.ProcessEnv = process.env): string {
  const tz = env.MISENARE_TZ?.trim() || 'Asia/Tokyo';
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
  } catch {
    throw new Error(`MISENARE_TZ が正しくありません（IANA の名前で書いてください。例: Asia/Tokyo）: ${tz}`);
  }
  return tz;
}

/** 指定タイムゾーンでの「今日」を YYYY-MM-DD で返す（toISOString は UTC なので 9 時間ずれる）。 */
export function todayIn(timeZone: string = appTimeZone(), now: Date = new Date()): string {
  // sv-SE の日付表記が YYYY-MM-DD なので、これを借りる
  return new Intl.DateTimeFormat('sv-SE', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export interface Finding {
  level: 'error' | 'warn' | 'info';
  key: string;
  message: string;
}

export interface ConfigReport {
  findings: Finding[];
  /** 起動を止めるべきか */
  fatal: boolean;
}

const isProduction = (env: NodeJS.ProcessEnv): boolean => env.NODE_ENV === 'production';

export function checkConfig(env: NodeJS.ProcessEnv = process.env): ConfigReport {
  const findings: Finding[] = [];
  const add = (level: Finding['level'], key: string, message: string): void => {
    findings.push({ level, key, message });
  };
  const prod = isProduction(env);

  if (!env.DATABASE_URL) add('error', 'DATABASE_URL', 'PostgreSQL の接続先が決まっていません');

  // 開発用のヘッダー認証は、本番では絶対に動かさない（誰にでもなれる）
  if (env.MISENARE_DEV_AUTH === '1') {
    if (prod) add('error', 'MISENARE_DEV_AUTH', '本番で開発用の認証は使えません（ヘッダーだけで誰にでもなれます）');
    else add('warn', 'MISENARE_DEV_AUTH', '開発用のヘッダー認証で動いています。本番では外してください');
  }

  if (!env.APP_URL) {
    add(prod ? 'error' : 'warn', 'APP_URL',
      '招待リンクの宛先が決まっていません（localhost のリンクが配られます）');
  } else if (prod && !env.APP_URL.startsWith('https://')) {
    add('error', 'APP_URL', '本番の宛先は https である必要があります（パスキーが動きません）');
  }

  if (!env.METRICS_TOKEN) {
    add(prod ? 'error' : 'warn', 'METRICS_TOKEN', '/metrics が合言葉なしで見られます');
  }

  if (env.RATE_LIMIT === 'db' && !env.MISENARE_RATE_SALT) {
    add('warn', 'MISENARE_RATE_SALT', '台をまたぐと、試行回数の数え方がずれます');
  }

  if (!env.S3_BUCKET) {
    add(prod ? 'warn' : 'info', 'S3_BUCKET', '写真はこの台のディスクに置かれます（台を増やすと見えなくなります）');
  }

  if (!env.ALERT_WEBHOOK_URL) {
    add(prod ? 'warn' : 'info', 'ALERT_WEBHOOK_URL', 'サーバー側のエラーが誰にも届きません');
  }

  // メール。決めなければ、申請が来ても本部に届かない（画面を開けば分かる）
  if (!env.SMTP_HOST || !env.MAIL_FROM) {
    add(prod ? 'warn' : 'info', 'SMTP_HOST',
      '知らせのメールを送れません（利用の申請は、画面を開くまで気づけません）');
  } else {
    if (!env.MAIL_FROM.includes('@')) add('error', 'MAIL_FROM', 'メールアドレスの形ではありません');
    const port = Number(env.SMTP_PORT ?? 587);
    if (!Number.isFinite(port) || port <= 0) add('error', 'SMTP_PORT', '番号ではありません');
    // 25 番は中継用で、ふつう認証も暗号化もできない。業者の窓口は 587 か 465
    if (port === 25 && env.SMTP_ALLOW_PLAINTEXT !== '1') {
      add('warn', 'SMTP_PORT', '25 番は暗号化できないことが多いです。587 か 465 をお使いください');
    }
    if (env.SMTP_USER && !env.SMTP_PASS) add('warn', 'SMTP_PASS', '利用者名はあるのに合言葉がありません');
    if (env.SMTP_ALLOW_PLAINTEXT === '1') {
      add(prod ? 'warn' : 'info', 'SMTP_ALLOW_PLAINTEXT',
        '暗号化しないまま送ります。合言葉と本文がそのまま流れるので、閉じた経路だけで使ってください');
    }
  }

  if (env.TOKENIZER !== 'kuromoji') {
    add('info', 'TOKENIZER', 'Intl.Segmenter で分割します（kuromoji のほうが検索が当たります）');
  }

  // 内緒の値を包む鍵。決めなければ、DB にそのままの形で入る
  const keys = env.MISENARE_SECRET_KEYS;
  if (!keys || keys.trim() === '') {
    add(prod ? 'warn' : 'info', 'MISENARE_SECRET_KEYS',
      '会社アカウントの内緒の鍵が、DB にそのままの形で入ります（バックアップが漏れると読まれます）');
  } else {
    // 形が違えば起動時に例外になるので、ここで先に見て、理由を出す
    const names = new Set<string>();
    for (const entry of keys.split(',')) {
      const text = entry.trim();
      if (text === '') continue;
      const at = text.indexOf(':');
      if (at <= 0) { add('error', 'MISENARE_SECRET_KEYS', `鍵の形が違います（名前:鍵 で並べてください）`); continue; }
      const name = text.slice(0, at);
      if (names.has(name)) add('error', 'MISENARE_SECRET_KEYS', `鍵の名前が重なっています: ${name}`);
      names.add(name);
      const length = Buffer.from(text.slice(at + 1), 'base64').length;
      if (length !== 32) add('error', 'MISENARE_SECRET_KEYS', `鍵 ${name} の長さが違います（32バイトを base64 で。いまは ${length} バイト）`);
    }
    const chosen = env.MISENARE_SECRET_KEY_ID;
    if (chosen !== undefined && !names.has(chosen)) {
      add('error', 'MISENARE_SECRET_KEY_ID', `${chosen} が鍵の一覧にありません`);
    }
    if (names.size > 1 && chosen === undefined) {
      add('warn', 'MISENARE_SECRET_KEY_ID', '鍵が複数あるのに、どれで包むか決めていません（並びの最後を使います）');
    }
  }

  // --- 入口（決めなければ、その入口が閉じているだけ） ---
  const rpId = env.WEBAUTHN_RP_ID;
  if (!rpId) {
    add('info', 'WEBAUTHN_RP_ID', 'パスキーは使えません（招待QRだけで動きます）');
  } else {
    const origins = (env.WEBAUTHN_ORIGINS ?? `https://${rpId}`).split(',').map((s) => s.trim()).filter(Boolean);
    // rpId はドメイン名。URL を入れると、端末が鍵を結びつけられない
    if (/[:/]/.test(rpId)) add('error', 'WEBAUTHN_RP_ID', 'ドメイン名だけを入れてください（https:// やポートは付けません）');
    if (prod && origins.some((o) => !o.startsWith('https://'))) {
      add('error', 'WEBAUTHN_ORIGINS', '本番では https の出どころだけを受け付けてください');
    }
    // 出どころが rpId のドメインでないと、端末が断る
    for (const origin of origins) {
      try {
        const host = new URL(origin).hostname;
        if (host !== rpId && !host.endsWith(`.${rpId}`)) {
          add('error', 'WEBAUTHN_ORIGINS', `${origin} は ${rpId} のドメインではありません（端末が断ります）`);
        }
      } catch {
        add('error', 'WEBAUTHN_ORIGINS', `${origin} は URL の形ではありません`);
      }
    }
    if (env.APP_URL && !env.APP_URL.includes(rpId)) {
      add('warn', 'WEBAUTHN_RP_ID', `APP_URL（${env.APP_URL}）と合っていません。別のドメインのパスキーは使えません`);
    }
  }

  const redirect = env.SSO_REDIRECT_URI;
  if (!redirect) {
    add('info', 'SSO_REDIRECT_URI', '会社のアカウントでは入れません（招待QRとパスキーだけで動きます）');
  } else {
    try {
      const parsed = new URL(redirect);
      if (prod && parsed.protocol !== 'https:') add('error', 'SSO_REDIRECT_URI', '本番では https である必要があります');
      if (!parsed.pathname.endsWith('/auth/sso/callback')) {
        add('warn', 'SSO_REDIRECT_URI', '経路は /api/auth/sso/callback です。相手に登録した値と1文字でも違うと弾かれます');
      }
    } catch {
      add('error', 'SSO_REDIRECT_URI', 'URL の形ではありません');
    }
  }

  return { findings, fatal: findings.some((f) => f.level === 'error') };
}

/** 人が読む形に整える（起動のログに出す） */
export function formatReport(report: ConfigReport): string[] {
  const mark = { error: '×', warn: '△', info: '・' } as const;
  return report.findings.map((f) => `${mark[f.level]} ${f.key}: ${f.message}`);
}
