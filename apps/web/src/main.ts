// ミセナレ Web 版。スマホのブラウザで「探す・書く・バーコード」を使う。
// 画面は URL のハッシュで切り替える：#/home（#/search?q= も同じ画面） #/k/<id> #/write #/edit/<id> #/scan #/memo #/settings #/manage #/device

import { api, ApiError, fetchDictionary, onUnauthorized, session, ssoSecret, type BookmarkItem, type Device, type Dictionary, type Hit, type Knowledge, type Me, type ProductCard, type ScanResult, type SearchResult } from './api.ts';
import { busyGuard, clear, freshness, freshnessBadge, getStaleDays, h, relativeDate, setStaleDays, submitOnce, tagChip, toast } from './dom.ts';
import { LocalDictionary, renderSuggestions, type PickEvent } from './tagInput.ts';
import { accessRequestPanel, action, askReadings, confirmAction, countedList, exportPanel, importPanel, productPanel, readingPanel, roleLabel, ssoPanel, staffPanel, tagPanel } from './manage.ts';
import { deletePasskey, guessDeviceName, listPasskeys, loginWithPasskey, passkeySupported, registerPasskey, type PasskeyRow } from './passkey.ts';
import { decodeImage } from './ean.ts';
import { renderMemos } from './memo.ts';
import { photoPicker, photoSection, uploadPhoto } from './photos.ts';
import { renderNotices, type Badges } from './notices.ts';
import { encodeQr, qrToSvg } from '@misenare/qr';

const root = document.getElementById('app')!;
let me: Me | null = null;
let dict: LocalDictionary | null = null;

// --- 起動 -------------------------------------------------------------------

async function boot(): Promise<void> {
  // 招待のQRコードは /app/#invite=<token> を開く
  const invite = /^#invite=(.+)$/.exec(location.hash);
  if (invite) return receiveInvite(decodeURIComponent(invite[1]!));
  // メールアドレスの確認リンクが開かれたところ。#verify-email=<鍵>
  const verify = /^#verify-email=(.+)$/.exec(location.hash);
  if (verify) return confirmEmail(decodeURIComponent(verify[1]!));
  // 会社アカウントから戻ってきたところ。#sso-code=<引換の符丁>[&to=#/...]
  const sso = /^#sso-code=([^&]+)(?:&to=(.+))?$/.exec(location.hash);
  if (sso) return finishSso(decodeURIComponent(sso[1]!), sso[2] ? decodeURIComponent(sso[2]) : '#/home');
  const ssoError = /^#sso-error=(.+)$/.exec(location.hash);
  if (ssoError) {
    history.replaceState(null, '', location.pathname);
    return renderWelcome(decodeURIComponent(ssoError[1]!));
  }
  if (!session.token) return renderWelcome();
  try {
    me = await api<Me>('GET', '/me');
    // 「古い」の判定はサーバーが決める（承認・管理の一覧と同じ値にするため）
    if (me.staleDays) setStaleDays(me.staleDays);
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) {
      session.token = null;
      return renderWelcome('この端末の登録が無効になりました。店長に招待をもう一度発行してもらってください。');
    }
    return renderFatal(e);
  }
  // 起動後に別の要求が 401 を受けたら（端末が無効にされた・セッションが切れた）、ここで招待画面へ戻す。
  // 起動時の /me は上の catch が自分で扱うので、/me が通ってから登録する
  onUnauthorized(backToWelcome);
  if (me.stores.length === 0) return renderFatal(new Error('所属している店舗がありません。店長に確認してください。'));
  if (!session.storeId || !me.stores.some((s) => s.id === session.storeId)) session.storeId = me.stores[0]!.id;
  // 辞書と数は互いに待つ必要が無いので、同時に取る（どちらも失敗を中で受けるので、片方の失敗で止まらない）。
  // 数は最初に1回取る。ホーム以外から開いた人にも、上の帯に申請の数が出るようにするため
  await Promise.all([loadDictionary(), refreshBadges()]);
  window.addEventListener('hashchange', route);
  route();
  if (bootNote) { toast(bootNote); bootNote = null; }
}

/** 401 を受けたときの戻り方。起動時の /me と同じく、トークンを捨てて招待画面へ */
function backToWelcome(): void {
  session.token = null;
  // hashchange で route() が走っても、古い画面を描き直さないようにする
  me = null;
  badges = null;
  location.hash = '';
  renderWelcome('セッションが切れました。もう一度登録してください');
}

/** 辞書の取得の世代。店舗を続けて切り替えたとき、遅れて届いた古い店舗の辞書で上書きしない */
let dictSeq = 0;

async function loadDictionary(): Promise<void> {
  const mine = ++dictSeq;
  try {
    const d = new LocalDictionary(await fetchDictionary(session.storeId!));
    if (mine === dictSeq) dict = d;
  } catch {
    if (mine === dictSeq) dict = null; // 辞書が取れなくても検索と投稿はできる（候補が出ないだけ）
  }
}

const storeId = () => session.storeId!;
const isTrusted = () => me !== null && (me.trustLevel === 'trusted' || me.adminScope !== 'none');
const isAdmin = () => me !== null && me.adminScope !== 'none';

// --- 招待の受け取り ------------------------------------------------------------

/**
 * 招待のリンクで開かれたとき。**この端末がすでに誰かとして入っているなら、受け取る前に確かめる。**
 *
 * 招待を受け取ると、この端末は招待された人のアカウントに入れ替わる。確かめずに受け取ると、
 * 送られてきたリンクを開いただけで、いまのログインが黙って別のアカウントに替わってしまう。
 */
async function receiveInvite(token: string): Promise<void> {
  if (!session.token) return acceptInvite(token);
  let current: Me;
  try {
    current = await api<Me>('GET', '/me');
  } catch {
    // いまの登録がもう使えない（切れている・通信できない）なら、確かめる相手がいない。そのまま受け取る
    return acceptInvite(token);
  }
  const stay = (): void => {
    history.replaceState(null, '', `${location.pathname}#/home`);
    void boot();
  };
  shell(null, h('section', { class: 'page welcome' },
    h('h1', {}, 'この端末を切り替えますか'),
    h('p', {}, `この端末は、いま「${current.name}」さんとして使っています。`),
    h('p', {}, '開いた招待を受け取ると、この端末は招待された人のアカウントに切り替わります。心当たりのないリンクなら、切り替えないでください。'),
    h('button', { type: 'button', class: 'primary block', onclick: stay }, `このまま「${current.name}」さんで使う`),
    h('button', { type: 'button', class: 'secondary block', onclick: () => { void acceptInvite(token); } }, '招待を受け取って切り替える'),
  ));
}

/**
 * 会社のアカウントから戻ってきたところ。引換の符丁と、入口でこの端末に控えた合言葉を持って、鍵を受け取る。
 * 合言葉が無い（＝この端末で始めていない）なら受け取らない。よそから渡された戻りの URL では入れ替わらない。
 */
async function finishSso(code: string, to: string): Promise<void> {
  history.replaceState(null, '', location.pathname);
  const verifier = ssoSecret.take();
  if (verifier === null) {
    if (session.token) return boot(); // すでに入っている端末で開かれただけ。いまのログインのまま続ける
    return renderWelcome('会社のアカウントでのログインは、始めたのと同じブラウザーで終えてください。もう一度お試しください。');
  }
  shell(null, h('section', { class: 'page center' }, h('p', {}, 'ログインしています…')));
  try {
    const r = await api<{ sessionToken: string }>('POST', '/auth/sso/finish', { code, verifier });
    session.token = r.sessionToken;
    history.replaceState(null, '', `${location.pathname}${to.startsWith('#/') ? to : '#/home'}`);
    await boot();
  } catch (e) {
    if (session.token) return boot();
    renderWelcome(e instanceof Error ? e.message : String(e));
  }
}

/** 入り直した直後に1回だけ出す知らせ（メールアドレスを登録しました、など） */
let bootNote: string | null = null;

/**
 * メールアドレスの確認リンクが開かれたところ。登録を申し込んだ本人のアカウントに、そのアドレスが入る。
 * リンクを開いた端末がだれとして入っていても、**いまのログインは変えない**（確認するだけ）。
 */
async function confirmEmail(token: string): Promise<void> {
  history.replaceState(null, '', session.token ? `${location.pathname}#/device` : location.pathname);
  shell(null, h('section', { class: 'page center' }, h('p', {}, 'メールアドレスを確かめています…')));
  let message: string;
  let ok = false;
  try {
    const r = await api<{ email: string }>('POST', '/auth/email-verify', { token });
    message = `メールアドレス（${r.email}）を登録しました。`;
    ok = true;
  } catch (e) {
    message = e instanceof Error ? e.message : String(e);
  }
  if (session.token) {
    bootNote = message;
    return boot();
  }
  renderWelcome(ok ? undefined : message, ok ? `${message}この画面は閉じてかまいません。` : undefined);
}

/** 招待の受け取り中。コードの貼り付け・QR・リンクのどこから来ても、同時に1回だけ走らせる */
let accepting = false;

async function acceptInvite(token: string): Promise<void> {
  if (accepting) return;
  accepting = true;
  shell(null, h('section', { class: 'page center' }, h('p', {}, '端末を登録しています…')));
  try {
    const deviceName = navigator.userAgent.includes('iPhone') ? 'iPhone' : navigator.userAgent.includes('Android') ? 'Android' : 'ブラウザ';
    const r = await api<{ sessionToken: string }>('POST', '/auth/accept', { token, deviceName });
    session.token = r.sessionToken;
    history.replaceState(null, '', `${location.pathname}#/home`);
    await boot();
  } catch (e) {
    renderWelcome(e instanceof Error ? e.message : String(e));
  } finally {
    accepting = false;
  }
}

function renderWelcome(error?: string, info?: string): void {
  const input = h('textarea', { id: 'invite', rows: 3, placeholder: '招待のリンクかコードを貼り付け', autocomplete: 'off' });
  const submit = () => {
    const v = input.value.trim();
    const m = /#invite=([^\s]+)/.exec(v);
    void acceptInvite(m ? decodeURIComponent(m[1]!) : v);
  };
  const problem = h('p', { class: 'error', role: 'alert', hidden: !error }, error ?? '');

  // パスキーを作ってある人は、招待を待たずに自分で入り直せる。
  // 端末を買い替えた・データを消した、は売場では普通に起きる。
  const signIn = h('button', { type: 'button', class: 'primary' }, 'パスキーで入る');
  signIn.onclick = async () => {
    problem.hidden = true;
    signIn.disabled = true;
    signIn.textContent = '端末で確認しています…';
    try {
      session.token = await loginWithPasskey();
      history.replaceState(null, '', `${location.pathname}#/home`);
      await boot();
      return;
    } catch (e) {
      // 利用者が途中でやめた場合は、失敗として騒がない
      const aborted = e instanceof DOMException && (e.name === 'NotAllowedError' || e.name === 'AbortError');
      problem.textContent = aborted ? 'パスキーでの確認が中断されました。' : e instanceof Error ? e.message : String(e);
      problem.hidden = false;
    }
    signIn.disabled = false;
    signIn.textContent = 'パスキーで入る';
  };

  // 会社のアカウント（社員向け）。打ったアドレスのドメインから、相手の IdP を決める。
  // 登録が無いドメインなら、その場で招待の案内に戻す。
  const email = h('input', { id: 'sso-email', type: 'email', autocomplete: 'username',
    placeholder: 'you@example.co.jp', inputmode: 'email' });
  // 相手の画面へ移り始めたあとは、戻ってくるまで押し直させない（action の finally はボタンを戻してしまう）
  let leaving = false;
  const company = action('会社のアカウントで入る', 'secondary', async () => {
    if (leaving) return;
    problem.hidden = true;
    const value = email.value.trim();
    if (value === '') { problem.textContent = '会社のメールアドレスを入れてください。'; problem.hidden = false; return; }
    email.disabled = true;
    try {
      // 戻ってきたときに鍵を受け取れるのは、ここで合言葉を控えたこの端末だけ
      const challenge = await ssoSecret.create();
      const r = await api<{ authorizeUrl: string }>('POST', '/auth/sso/start', { email: value, challenge });
      leaving = true;
      // 「戻る」で戻ってきたとき（ページが丸ごと復元される）は、もう一度押せるようにする
      window.addEventListener('pageshow', () => { leaving = false; }, { once: true });
      location.href = r.authorizeUrl;
    } catch (e) {
      problem.textContent = e instanceof Error ? e.message : String(e);
      problem.hidden = false;
    } finally {
      email.disabled = false;
    }
  });

  // メールでログインリンクを受け取る：端末のセッションもパスキーも無くなったときの戻り道。
  // 応答は常に同じ（登録の有無を漏らさない）。
  const linkEmail = h('input', { id: 'link-email', type: 'email', autocomplete: 'username',
    placeholder: 'you@example.co.jp', inputmode: 'email' });
  const linkOut = h('p', { class: 'hint', 'aria-live': 'polite', hidden: true });
  const sendLink = action('ログインリンクをメールで送る', 'secondary', async () => {
    const v = linkEmail.value.trim();
    if (v === '') { problem.textContent = 'メールアドレスを入れてください。'; problem.hidden = false; return; }
    problem.hidden = true;
    await api('POST', '/auth/email-link', { email: v }).catch(() => {});
    linkOut.textContent = `登録があれば、${v} にログイン用のリンクを送りました。メールを開いてリンクをタップしてください。`;
    linkOut.hidden = false;
  });

  shell(null, h('section', { class: 'page welcome' },
    h('h1', { class: 'brand' }, 'ツギガミ'),
    h('p', { class: 'lead' }, '店のやり方を、接客の合間にすぐ探せます。'),
    info ? h('p', { class: 'note', role: 'status' }, info) : null,
    problem,
    passkeySupported() ? h('div', { class: 'welcome-signin' },
      signIn,
      h('p', { class: 'hint' }, 'この端末にパスキーを作ってある場合は、こちらから入れます。'),
    ) : null,
    h('p', { class: 'or' }, '前に使っていて、入れなくなった方'),
    h('label', { for: 'link-email' }, '登録したメールアドレス'),
    linkEmail,
    sendLink,
    linkOut,
    h('p', { class: 'or' }, '会社のアカウントをお持ちの方'),
    h('label', { for: 'sso-email' }, '会社のメールアドレス'),
    email,
    company,
    h('p', { class: 'or' }, 'はじめての端末'),
    h('p', {}, '使い始めるには、店長が発行する招待のQRコードをスマホのカメラで読み取ってください。'),
    h('label', { for: 'invite' }, 'リンクやコードを受け取った場合'),
    input,
    h('button', { type: 'button', class: 'secondary', onclick: submit }, 'この端末を登録する'),
  ));
}

function renderFatal(e: unknown): void {
  shell(null, h('section', { class: 'page center' }, h('p', { class: 'error', role: 'alert' }, e instanceof Error ? e.message : String(e))));
}

// --- この端末 -------------------------------------------------------------------
//
// パスキーの管理は、店長だけでなく**全員**が使う。端末を替えたときに自分で
// 入り直せるようにするのが目的なので、承認・管理（trusted 以上）には置かない。

/** 端末がどうやって増えたか（一覧に添える言葉） */
function deviceOrigin(d: Device): string {
  switch (d.origin) {
    case 'invite': return d.issuedBy ? `${d.issuedBy}さんの招待で登録` : '招待で登録';
    case 'added': return d.issuedBy ? `${d.issuedBy}さんが追加` : '管理者が追加';
    case 'self': return '自分で追加（別の端末でログイン）';
    case 'email': return 'メールのログインリンクで追加';
    case 'passkey': return 'パスキーで入った端末';
    case 'sso': return '会社のアカウントで入った端末';
    default: return '';
  }
}

async function renderDevice(stale: () => boolean): Promise<void> {
  const section = h('section', { class: 'page' },
    h('h1', {}, 'この端末の設定'),
    h('p', { class: 'hint' }, `いまお使いの端末：${guessDeviceName()}`),
  );
  shell('settings', section);

  // 自分のアカウントで入っている端末。増えた端末があれば、いちばん上で知らせる
  const devicesBox = h('div');
  section.append(devicesBox);
  const drawDevices = async (): Promise<void> => {
    let fresh: Device[];
    let all: Device[];
    let newEmail: string | null = null;
    try {
      [fresh, all] = await Promise.all([
        api<Me>('GET', '/me').then((m) => {
          // ほかの端末で確認のリンクを開いた直後でも、登録中のメールアドレスが古いままにならないよう取り直す
          if (me) me.email = m.email;
          newEmail = m.newEmail ?? null;
          return m.newDevices ?? [];
        }),
        api<Device[]>('GET', '/me/devices'),
      ]);
    } catch (e) {
      if (stale()) return;
      clear(devicesBox);
      devicesBox.append(h('h2', {}, 'ログイン中の端末'), h('p', { class: 'hint' }, e instanceof Error ? e.message : String(e)));
      return;
    }
    if (stale()) return;
    clear(devicesBox);
    const stop = (d: Device) => confirmAction('止める', 'secondary small',
      `${d.deviceName ?? 'この端末'}を止めます。その端末からは使えなくなります。`,
      async () => { await api('DELETE', `/sessions/${d.id}`); toast('止めました'); await drawDevices(); });
    const dismiss = (): HTMLElement => action('心当たりがあるので、この知らせを消す', 'secondary', async () => {
      await api('POST', '/me/devices/seen');
      await refreshBadges();
      await drawDevices();
    });
    if (fresh.length > 0) {
      devicesBox.append(
        h('h2', {}, '新しく増えた端末'),
        h('p', { class: 'pending' }, 'このアカウントで使える端末が増えました。心当たりがなければ、止めてから店長か本部に知らせてください。'),
        h('ul', { class: 'rows' }, ...fresh.map((d) => h('li', { class: 'row' },
          h('span', {}, d.deviceName ?? '名前のない端末'),
          h('span', { class: 'hint' }, [`${relativeDate(d.createdAt)}に追加`, deviceOrigin(d), d.revoked ? 'すでに止められています' : ''].filter(Boolean).join('・')),
          d.revoked ? null : h('span', { class: 'row-actions' }, stop(d))))),
      );
    }
    if (newEmail !== null) {
      devicesBox.append(
        h('h2', {}, '登録されたメールアドレス'),
        h('p', { class: 'pending' }, `ログイン用のメールアドレスとして ${newEmail} が登録されました。このアドレスあてのリンクで、このアカウントに入れます。心当たりがなければ、下の「メールアドレス」で登録を外してください。`),
      );
    }
    if (fresh.length > 0 || newEmail !== null) devicesBox.append(dismiss());
    devicesBox.append(
      h('h2', {}, 'ログイン中の端末'),
      h('p', { class: 'hint' }, 'あなたのアカウントで、いま使える端末です。使っていない端末や心当たりのない端末は止められます。'),
      h('ul', { class: 'rows' }, ...all.map((d) => h('li', { class: 'row' },
        h('span', {}, d.deviceName ?? '名前のない端末', d.current ? h('span', { class: 'notice-badge' }, 'この端末') : null),
        h('span', { class: 'hint' }, [deviceOrigin(d), `${relativeDate(d.createdAt)}に登録`, `最後に使った日 ${relativeDate(d.lastUsedAt)}`].filter(Boolean).join('・')),
        d.current ? null : h('span', { class: 'row-actions' }, stop(d))))),
    );
  };
  await drawDevices();
  if (stale()) return;

  // 別の端末でログイン：どの端末でも出す（パスキーの引き継ぎがうまくいかない端末の逃げ道にもなる）。
  {
    const linkOut = h('div', { class: 'invite-out', 'aria-live': 'polite' });
    const makeLink = action('ログイン用のURLを発行する', 'secondary', async () => {
      clear(linkOut);
      try {
        const r = await api<{ url: string; expiresAt: string }>('POST', '/me/device-link', {});
        const qr = h('div', { class: 'qr' });
        qr.innerHTML = qrToSvg(encodeQr(r.url), { label: '別の端末でログインするQRコード' });
        linkOut.append(
          h('p', {}, 'もう一方の端末でこのQRを読み取るか、下のURLを開くと、その端末で同じアカウントにログインできます（1回限り・30分以内）。'),
          qr,
          h('textarea', { rows: 3, readonly: true, class: 'invite-link' }, r.url),
          h('div', { class: 'actions' },
            h('button', { type: 'button', class: 'secondary', onclick: async () => { await navigator.clipboard.writeText(r.url).catch(() => {}); toast('コピーしました'); } }, 'URLをコピー')));
      } catch (e) {
        linkOut.append(h('p', { class: 'error', role: 'alert' }, e instanceof Error ? e.message : String(e)));
      }
    });
    section.append(
      h('h2', {}, '別の端末でログイン'),
      h('p', {}, 'スマホとパソコンなど、もう一方の端末でも同じアカウントで使いたいときに。URLかQRコードを発行して、その端末で開くとログインできます。'),
      h('p', { class: 'hint' }, 'パスキーの引き継ぎがうまくいかないときの入り方としても使えます。発行したURLは30分で切れ、1回使うと無効になります。'),
      makeLink,
      linkOut,
    );
  }

  // メールアドレスの登録：入れなくなったとき「メールでログインリンク」を受け取れるようにする。
  {
    const current = h('p', { class: 'hint' });
    const emailInput = h('input', { id: 'my-email', type: 'email', autocomplete: 'username',
      placeholder: 'you@example.co.jp', inputmode: 'email', value: me!.email ?? '' });
    const emailOut = h('p', { 'aria-live': 'polite', hidden: true });
    const say = (text: string, cls: string): void => { emailOut.textContent = text; emailOut.className = cls; emailOut.hidden = false; };
    const removeBox = h('span');
    const drawCurrent = (): void => {
      current.textContent = me!.email ? `登録中：${me!.email}` : 'まだ登録されていません。';
      clear(removeBox);
      if (me!.email) {
        removeBox.append(confirmAction('登録を外す', 'secondary small', 'メールでの入り直しができなくなります。外しますか？', async () => {
          await api('POST', '/me/email', { email: '' });
          me!.email = null;
          emailInput.value = '';
          drawCurrent();
          say('登録を外しました。', 'hint');
        }));
      }
    };
    drawCurrent();
    // 打っただけでは登録しない。そのアドレスに確認のリンクを送り、開かれたら登録する
    // （届かないアドレスや、他人のアドレスが入らないように）
    const saveEmail = action('確認のメールを送る', 'secondary', async () => {
      emailOut.hidden = true;
      try {
        const r = await api<{ pending: string }>('POST', '/me/email', { email: emailInput.value });
        say(`${r.pending} に確認のメールを送りました。メールのリンクを開くと登録されます（30分以内）。開くまでは、登録は変わりません。`, 'note');
      } catch (e) {
        say(e instanceof Error ? e.message : String(e), 'error');
      }
    });
    section.append(
      h('h2', {}, 'メールアドレス'),
      h('p', {}, '登録しておくと、パスキーもこの端末も使えなくなったときに、ログイン画面からメールでログインリンクを受け取って入り直せます。'),
      current,
      removeBox,
      h('label', { for: 'my-email' }, 'メールアドレス'),
      emailInput,
      saveEmail,
      emailOut,
    );
  }

  // 「タブを消して戻れない」対策：ホーム画面に追加してもらう案内（アプリはPWA）。
  section.append(
    h('h2', {}, 'ホーム画面に追加'),
    h('p', {}, 'このページをホーム画面に追加しておくと、タブを閉じてもアイコンから開けます。'),
    h('p', { class: 'hint' }, 'iPhone（Safari）：共有ボタン → 「ホーム画面に追加」。Android（Chrome）：右上のメニュー → 「ホーム画面に追加」。'),
  );

  // ログアウト：店の共用端末を次の人に渡すとき、機種変更の前など。この端末の登録だけを消す
  const logoutSection = (): HTMLElement[] => [
    h('h2', {}, 'ログアウト'),
    h('p', {}, 'この端末からログアウトします。ほかの端末はそのまま使えます。'),
    h('p', { class: 'hint' }, 'もう一度使うには、パスキー・登録したメールアドレスへのログインリンク・店長からの招待のどれかが要ります。'),
    confirmAction('この端末からログアウトする', 'secondary', 'ログアウトしますか？', async () => {
      await api('POST', '/auth/logout');
      session.token = null;
      me = null;
      badges = null;
      location.hash = '';
      renderWelcome(undefined, 'ログアウトしました。');
    }),
  ];

  const list = h('div');
  const problem = h('p', { class: 'error', role: 'alert', hidden: true });

  const refresh = async (): Promise<void> => {
    clear(list);
    let rows: PasskeyRow[];
    try {
      rows = await listPasskeys();
    } catch (e) {
      if (stale()) return;
      list.append(h('p', { class: 'hint' }, e instanceof Error ? e.message : String(e)));
      return;
    }
    if (stale()) return;
    list.append(...countedList('登録したパスキー', rows, (row, remove) =>
      h('li', { class: 'row' },
        h('span', {}, row.name ?? '名前なし'),
        h('span', { class: 'hint' },
          row.disabled ? '使えません' : row.last_used_at ? `最後に使った日 ${relativeDate(row.last_used_at)}` : 'まだ使っていません'),
        h('span', { class: 'row-actions' },
          confirmAction('消す', 'secondary small', `${row.name ?? 'このパスキー'}を消します。この端末からは入れなくなります。`,
            async () => { await deletePasskey(row.id); toast('消しました'); remove(); })))));
  };

  if (!passkeySupported()) {
    section.append(h('p', { class: 'note' }, 'この端末ではパスキーを使えません。入り直すときは、店長に招待をもう一度発行してもらってください。'));
    section.append(...logoutSection());
    return;
  }

  const add = action('この端末にパスキーを作る', 'primary', async () => {
    problem.hidden = true;
    try {
      await registerPasskey();
      toast('パスキーを作りました');
      await refresh();
    } catch (e) {
      const aborted = e instanceof DOMException && (e.name === 'NotAllowedError' || e.name === 'AbortError');
      problem.textContent = aborted ? '端末での確認が中断されました。' : e instanceof Error ? e.message : String(e);
      problem.hidden = false;
    }
  });

  section.append(
    h('h2', {}, 'パスキー'),
    h('p', {}, 'この端末にパスキーを作っておくと、端末を替えたときやデータを消したときに、招待を待たずに自分で入り直せます。'),
    h('p', { class: 'hint' }, '鍵は端末の中に残ります。暗証番号や指紋での確認が要るので、他の人には使えません。'),
    add,
    problem,
    list,
  );
  section.append(...logoutSection());
  await refresh();
}

// --- 画面の枠 -------------------------------------------------------------------

type Tab = 'home' | 'notices' | 'write' | 'settings';

/** 前の画面が抱えている後始末（写真の表示用URLの解放など） */
let disposeView: (() => void) | null = null;

/** 店舗の切り替えの世代 */
let storeSwitchSeq = 0;

function shell(tab: Tab | null, ...content: Node[]): void {
  disposeView?.();
  disposeView = null;
  clear(root);
  const store = me?.stores.find((s) => s.id === session.storeId);
  const header = me ? h('header', { class: 'topbar' },
    me.stores.length > 1
      ? h('select', { class: 'store-select', 'aria-label': '店舗', onchange: async (e: Event) => {
          // 続けて切り替えたら、最後に選んだ店舗の辞書で描く（先の切り替えは途中で手を引く）
          const mine = ++storeSwitchSeq;
          session.storeId = (e.target as HTMLSelectElement).value;
          await loadDictionary();
          if (mine !== storeSwitchSeq) return;
          route();
        } }, ...me.stores.map((s) => h('option', { value: s.id, ...(s.id === session.storeId ? { selected: true } : {}) }, s.name)))
      : h('span', { class: 'store-name' }, store?.name ?? ''),
  ) : null;
  const nav = me ? h('nav', { class: 'tabbar', 'aria-label': '画面の切り替え' },
    navLink('#/home', 'ホーム', tab === 'home'),
    navLink('#/notices', '連絡', tab === 'notices', badgeCount()),
    navLink('#/write', '書く', tab === 'write'),
    // 承認・管理と、この端末の設定への入口。利用の申請の数は、どの画面にいても目に入るようにここに出す
    navLink('#/settings', '設定', tab === 'settings', manageCount()),
  ) : null;
  root.append(...[header, h('main', { class: 'content' }, ...content), nav].filter((x): x is HTMLElement => x !== null));
}

function navLink(href: string, label: string, active: boolean, count = 0): HTMLElement {
  return h('a', { href, class: `tab${active ? ' tab-active' : ''}`, ...(active ? { 'aria-current': 'page' } : {}) },
    label,
    count > 0 ? h('span', { class: 'tab-count', 'aria-label': `${count}件` }, String(count)) : null);
}

/** 連絡タブに出す数（未読＋未確認＋残っている引き継ぎ） */
let badges: Badges | null = null;
/** badges を取った時刻。起動直後のホームが同じ数をもう一度取らないために持つ */
let badgesAt = 0;
let badgesStore = '';
function badgeCount(): number {
  if (!badges) return 0;
  return badges.notices.unread + badges.notices.needsAck + badges.handovers.open;
}

/** 「設定」タブに出す数（承認できる人にだけ：利用の申請） */
function manageCount(): number {
  return isTrusted() ? (badges?.accessRequests?.pending ?? 0) : 0;
}

/** 「設定」タブに出す件数を、いまの数に合わせる */
function updateManageCount(): void {
  const link = document.querySelector('.tabbar a[href="#/settings"]');
  if (!link) return;
  link.querySelector('.tab-count')?.remove();
  const pending = manageCount();
  if (pending > 0) {
    link.append(h('span', { class: 'tab-count', 'aria-label': `利用の申請が${pending}件` }, String(pending)));
  }
}

/**
 * 数を取り直して、タブの表示を更新する。
 * maxAgeMs を渡すと、それより新しく取れていれば取り直さない（起動の直後にホームが開くときだけ使う）。
 */
async function refreshBadges(maxAgeMs = 0): Promise<void> {
  if (!me || !session.storeId) return;
  // 店舗を切り替えた直後は、新しい店舗の数を取る（古い店舗の数を5秒使い回さない）
  if (badges && badgesStore === storeId() && Date.now() - badgesAt < maxAgeMs) return;
  // await の間に店舗が切り替わっても、取った数を別の店舗のものとして入れない
  const sid = storeId();
  try {
    const got = await api<Badges>('GET', `/stores/${sid}/badges`);
    if (sid !== session.storeId) return;
    badges = got;
    badgesAt = Date.now();
    badgesStore = sid;
  } catch {
    if (sid !== session.storeId) return;
    badges = null;
  }
  const tab = document.querySelector('.tabbar a[href="#/notices"]');
  if (!tab) return;
  const existing = tab.querySelector('.tab-count');
  existing?.remove();
  const count = badgeCount();
  if (count > 0) tab.append(h('span', { class: 'tab-count', 'aria-label': `${count}件` }, String(count)));
  updateManageCount();
}

// --- ルーティング ---------------------------------------------------------------

/**
 * 画面の世代。非同期で描く画面は、await のあとで世代が進んでいたら（先に別の画面へ移っていたら）
 * 何もしない。遅れて届いた応答が、いま見ている画面を上書きするのを防ぐ。
 */
let routeGen = 0;

function route(): void {
  // 401 で招待画面へ戻したあとに残ったイベントでは、画面を描かない
  if (!me) return;
  const gen = ++routeGen;
  const stale = () => gen !== routeGen;
  const hash = location.hash || '#/home';
  const [path, query] = hash.slice(1).split('?') as [string, string | undefined];
  const params = new URLSearchParams(query ?? '');
  const k = /^\/k\/([0-9a-f-]{36})$/.exec(path);
  const edit = /^\/edit\/([0-9a-f-]{36})$/.exec(path);
  // 「探す」はホームに統合した。前からある #/search?q=… の行き先も、同じ画面で受ける
  if (path === '/search') return void renderHome(params.get('q') ?? '');
  if (path === '/settings') return renderSettings();
  // 「書く」は2つ：みんなと共有するメモ（＝ナレッジ）と、自分だけの個人メモ。#/memo は前の行き先
  if (path === '/write') return params.get('kind') === 'personal' ? renderMemoTab() : renderWrite(null);
  if (edit) return void loadAndEdit(edit[1]!, stale);
  if (k) return void renderKnowledge(k[1]!, stale);
  if (path === '/scan') return renderScan(params.get('jan') ?? '', stale);
  if (path === '/notices') return void renderNoticesTab();
  if (path === '/memo') return renderMemoTab();
  if (path === '/manage') return void renderManage(stale);
  if (path === '/device') return void renderDevice(stale);
  const staff = /^\/staff\/([0-9a-f-]{36})$/.exec(path);
  if (staff) return void renderStaff(staff[1]!, stale);
  return void renderHome('');
}

// --- ホーム ---------------------------------------------------------------------

async function renderHome(initial: string): Promise<void> {
  // ホームと「探す」は1つの画面。何も打っていないあいだはホームの中身（お知らせ・タグ・ブックマーク）を見せ、
  // 打ち始めたら、その場で候補と結果に入れ替える。
  const tags = dict ? [...dict.dictionary.tags.values()].sort((a, b) => b.useCount - a.useCount).slice(0, 12) : [];
  const alert = h('div', { class: 'home-alert', hidden: true });
  const bookmarks = h('div', { class: 'home-bookmarks' });
  const homeStore = storeId();
  const greeting = h('h1', {}, `${me!.name}さん`);
  const scanRow = h('p', { class: 'search-or' }, h('span', {}, 'または'), h('a', { href: '#/scan', class: 'secondary' }, 'バーコードで商品を調べる'));
  const homeBody = h('div', { class: 'home-body' },
    tags.length > 0 ? h('h2', {}, 'よく使われるタグ') : null,
    tags.length > 0 ? h('div', { class: 'tag-row' }, ...tags.map((t) => tagChip(t.name, { onClick: () => { location.hash = `#/search?q=${encodeURIComponent('#' + t.name)}`; } }))) : null,
    bookmarks,
    me!.trustLevel === 'visitor' && !isAdmin()
      ? h('p', { class: 'note' }, 'あなたの投稿や修正は、trusted のメンバーが承認すると公開されます。')
      : null,
  );
  let alertFilled = false;
  const showHome = (on: boolean) => {
    greeting.hidden = !on;
    homeBody.hidden = !on;
    scanRow.hidden = !on;
    scanRow.parentElement?.classList.toggle('searching', !on);
    alert.hidden = !on || !alertFilled;
  };

  const input = h('input', { type: 'search', id: 'q', value: initial, placeholder: 'タグや言葉で探す', autocomplete: 'off', enterkeyhint: 'search', 'aria-label': '検索' });
  const suggest = h('div', { class: 'suggest', hidden: true });
  const results = h('div', { class: 'results', 'aria-live': 'polite' });
  let pendingPick: { suggestedTagId: string; pickedTagId: string } | null = null;
  // 確定して記録済みの検索語とそのログID。二重記録を防ぐために持つ。
  let logged: { q: string; id: number } | null = null;
  let timer: number | undefined;
  // 入力中の自動検索と Enter の検索の応答が前後しても、最後に投げた検索の結果だけを描く
  let seq = 0;

  const lastToken = () => input.value.split(/\s+/).pop() ?? '';
  const updateSuggest = () => {
    const token = lastToken();
    // # が付いていなくても候補を出す。ひらがな・ローマ字でも引けるので、
    // 「てれび」「terebi」と打っている途中で #テレビ と、その同義語が出る。
    if (!dict || token.length < 2) { suggest.hidden = true; return; }
    const selected = input.value.split(/\s+/).slice(0, -1).filter((t) => t.startsWith('#')).map((t) => t.slice(1));
    renderSuggestions(suggest, token, dict.suggest(token, selected), pick, false);
  };
  const pick = (e: PickEvent) => {
    const words = input.value.split(/\s+/);
    words[words.length - 1] = `#${e.tag.name}`;
    input.value = `${words.join(' ')} `;
    if (e.maybeFor && e.tag.id) pendingPick = { suggestedTagId: e.maybeFor, pickedTagId: e.tag.id };
    suggest.hidden = true;
    input.focus();
    void run(true);
  };
  const run = async (record: boolean) => {
    const q = input.value.trim();
    history.replaceState(null, '', q ? `#/search?q=${encodeURIComponent(q)}` : '#/home');
    const mine = ++seq;
    showHome(!q);
    if (!q) { clear(results); return; }
    try {
      // 入力中のライブ検索は記録しない（record=0）。打ちかけの語で 0件ワードを汚さない。
      const url = `/stores/${storeId()}/search?q=${encodeURIComponent(q)}${record ? '' : '&record=0'}`;
      const r = await api<SearchResult>('GET', url);
      if (mine !== seq) return;
      if (record && r.logId != null) logged = { q, id: r.logId };
      results.dataset.query = q;
      renderResults(results, r, q, (tag) => { input.value = `${input.value.trim()} #${tag} `; void run(true); }, openResult);
      if (pendingPick && r.logId != null) {
        void api('POST', `/search-logs/${r.logId}/feedback`, pendingPick).catch(() => {});
        pendingPick = null;
      }
    } catch (e) {
      if (mine !== seq) return;
      clear(results);
      results.append(h('p', { class: 'error', role: 'alert' }, e instanceof Error ? e.message : String(e)));
    }
  };
  // 確定した検索語を1回だけ記録する。直近の記録と同じ語ならそのIDを使い回す。
  const commitLog = async (): Promise<number | null> => {
    const q = input.value.trim();
    if (!q) return null;
    if (logged && logged.q === q) return logged.id;
    try {
      const r = await api<SearchResult>('GET', `/stores/${storeId()}/search?q=${encodeURIComponent(q)}`);
      if (r.logId != null) logged = { q, id: r.logId };
      return r.logId;
    } catch { return null; }
  };
  // 結果を開いたとき：その検索語を記録してから「開いた」を紐づける。
  const openResult = (knowledgeId: string) => {
    void commitLog().then((id) => {
      if (id != null) void api('POST', `/search-logs/${id}/feedback`, { openedKnowledgeId: knowledgeId }).catch(() => {});
    });
  };
  input.addEventListener('input', () => {
    // 打ち始めたら、すぐに結果の場所を空ける（消したら、ホームの中身を戻す）
    showHome(input.value.trim() === '');
    updateSuggest();
    window.clearTimeout(timer);
    timer = window.setTimeout(() => void run(false), 450);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); window.clearTimeout(timer); suggest.hidden = true; void run(true); }
  });

  shell('home', h('section', { class: 'page' },
    greeting,
    alert,
    // 検索欄は幅いっぱい。その下に「または」と、バーコードで調べる入口を並べる
    // （JAN の小さなボタンは、行き先が同じなのでやめた）
    h('div', { class: 'search-block' },
      h('div', { class: 'search-bar' }, input),
      // 打ち方の手がかりは、欄に入っているあいだ・探しているあいだだけ出す
      h('p', { class: 'hint search-hint' }, 'ひらがな・ローマ字でも候補が出ます（てれび／terebi → #テレビ）'),
      scanRow),
    suggest,
    results,
    homeBody,
  ));
  showHome(initial.trim() === '');
  // 探しに来たとき（タグを押した・前の検索に戻った）だけ、入力欄に入る。
  // ホームを開いただけでは入らない（スマホで、開くたびにキーボードが出てしまう）
  if (initial) { input.focus(); void run(true); }

  // 自分のブックマーク。無ければ欄ごと出さない（取れなくても、ホームのほかの部分はそのまま使える）
  void api<BookmarkItem[]>('GET', `/stores/${homeStore}/bookmarks`).then((list) => {
    if (!bookmarks.isConnected || list.length === 0) return;
    bookmarks.append(
      h('h2', {}, 'ブックマーク'),
      h('ul', { class: 'rows' }, ...list.map((b) => h('li', { class: 'row bookmark-row' },
        h('a', { href: `#/k/${b.id}` }, b.title),
        b.tags.length > 0 ? h('span', { class: 'tag-row' }, ...b.tags.slice(0, 3).map((t) => tagChip(t, { quiet: true }))) : null))));
  }).catch(() => {});
  // 連絡と引き継ぎの数は、ホームにも出す（出勤してすぐ気づけるように）。
  // 起動で取ったばかり（5秒以内）なら、もう一度は取らない。画面を移ってきたときは今までどおり取り直す
  await refreshBadges(5000);
  const parts: string[] = [];
  if (badges) {
    if (badges.notices.needsAck > 0) parts.push(`確認がまだの連絡が${badges.notices.needsAck}件`);
    else if (badges.notices.unread > 0) parts.push(`未読の連絡が${badges.notices.unread}件`);
    if (badges.handovers.open > 0) {
      parts.push(badges.handovers.carriedOver > 0
        ? `引き継ぎが${badges.handovers.open}件（うち持ち越し${badges.handovers.carriedOver}件）`
        : `引き継ぎが${badges.handovers.open}件`);
    }
  }
  clear(alert);
  if (parts.length > 0) {
    alert.append(h('a', { href: '#/notices' }, `${parts.join('、')}あります`));
  }
  // 利用の申請は、待っている人がいる話なので別の行で出す。
  // 承認・管理を開かないと気づけないと、申請した人がいつまでも入れない。
  const pending = manageCount();
  if (pending > 0) {
    alert.append(h('a', { href: '#/manage', class: 'alert-request' },
      `利用の申請が${pending}件あります（承認すると使えるようになります）`));
  }
  // 端末が増えたときは、本人に必ず知らせる。店長や本部は端末をなくした人のために鍵を作り直せるので、
  // 身に覚えのない端末が増えていないかを、本人が自分で確かめられるようにする
  const added = badges?.devices?.added ?? 0;
  if (added > 0) {
    alert.append(h('a', { href: '#/device', class: 'alert-request' },
      `このアカウントに端末が${added}台増えました。心当たりを確かめてください`));
  }
  // メールアドレスの登録も同じ。登録したアドレスにはログイン用のリンクが届くので、入り方が1つ増えたのと同じ
  if (badges?.devices?.emailChanged) {
    alert.append(h('a', { href: '#/device', class: 'alert-request' },
      'このアカウントにメールアドレスが登録されました。心当たりを確かめてください'));
  }
  alertFilled = alert.childNodes.length > 0;
  showHome(input.value.trim() === '');
}

// --- 設定（承認・管理と、この端末の設定への入口） ---------------------------------

function renderSettings(): void {
  const pending = manageCount();
  shell('settings', h('section', { class: 'page' },
    h('h1', {}, '設定'),
    h('ul', { class: 'rows settings-list' },
      isTrusted()
        ? h('li', { class: 'row' }, h('a', { href: '#/manage', class: 'settings-link' },
            h('span', { class: 'settings-title' }, '承認・管理',
              pending > 0 ? h('span', { class: 'tab-count', 'aria-label': `利用の申請が${pending}件` }, String(pending)) : null),
            h('span', { class: 'hint' }, '投稿の承認、見つからなかった検索、タグ、スタッフの招待など')))
        : null,
      h('li', { class: 'row' }, h('a', { href: '#/device', class: 'settings-link' },
        h('span', { class: 'settings-title' }, 'この端末の設定'),
        h('span', { class: 'hint' }, 'パスキー、メールアドレス、ほかの端末で使う、ログアウト')))),
  ));
}

// --- 連絡 -------------------------------------------------------------------------

function renderNoticesTab(): void {
  const section = h('section', { class: 'page' });
  shell('notices', section);
  renderNotices(section, {
    storeId: storeId(),
    userName: me!.name,
    isTrusted: isTrusted(),
    onBadges: () => void refreshBadges(),
  });
}

// --- 書く：共有メモと個人メモの切り替え ---------------------------------------------

/**
 * 「書く」の上に出す切り替え。
 *   共有メモ … 店のみんなと共有する。承認を経てナレッジになり、検索に出る
 *   個人メモ … 自分だけが見られる
 */
function writeSwitch(current: 'shared' | 'personal'): HTMLElement {
  const item = (kind: 'shared' | 'personal', href: string, label: string) =>
    h('a', { href, class: `seg${current === kind ? ' seg-on' : ''}`, ...(current === kind ? { 'aria-current': 'page' } : {}) }, label);
  return h('nav', { class: 'seg-row', 'aria-label': '書くものの種類' },
    item('shared', '#/write', '共有メモ'),
    item('personal', '#/write?kind=personal', '個人メモ'));
}

function renderMemoTab(): void {
  const section = h('section', { class: 'page' }, writeSwitch('personal'));
  shell('write', section);
  renderMemos(section);
}

// --- 探す -------------------------------------------------------------------------

function renderResults(container: HTMLElement, r: SearchResult, q: string, addTag: (tag: string) => void, onOpen: (knowledgeId: string) => void): void {
  clear(container);
  if (r.hits.length === 0) {
    container.append(h('div', { class: 'empty' },
      h('p', {}, `「${q}」に当てはまるナレッジはまだありません。`),
      h('p', {}, '近くの社員に聞いて、教わった内容を残しておくと次の人が助かります。'),
      h('a', { href: '#/write', class: 'primary block' }, '共有メモを書く')));
    return;
  }
  if (r.chips.length > 0) {
    container.append(h('div', { class: 'tag-row chips' }, ...r.chips.map((c) => tagChip(`${c.name}`, { onClick: () => addTag(c.name), quiet: true }))));
  }
  container.append(hitList(r.hits, onOpen));
}

function hitList(hits: Hit[], onOpen?: (knowledgeId: string) => void): HTMLElement {
  return h('ol', { class: 'hits' }, ...hits.map((hit) =>
    h('li', {},
      h('a', {
        href: `#/k/${hit.id}`,
        class: 'hit',
        onclick: () => onOpen?.(hit.id),
      },
        h('span', { class: 'hit-title' }, hit.linked ? h('span', { class: 'linked' }, 'この商品の') : null, hit.title),
        h('span', { class: 'hit-snippet' }, hit.snippet),
        h('span', { class: 'hit-meta' }, ...hit.tags.slice(0, 4).map((t) => tagChip(t, { quiet: true })),
          freshnessBadge(hit.updatedAt, hit.verifiedAt))))));
}

// --- ナレッジの詳細 ---------------------------------------------------------------

async function renderKnowledge(id: string, stale: () => boolean): Promise<void> {
  let k: Knowledge;
  try {
    k = await api<Knowledge>('GET', `/knowledge/${id}`);
  } catch (e) {
    if (stale()) return;
    return shell('home', h('section', { class: 'page' }, h('p', { class: 'error', role: 'alert' }, e instanceof Error ? e.message : String(e))));
  }
  if (stale()) return; // 応答を待つ間に別の画面へ移っていたら、遅れて届いた詳細で上書きしない
  // 写真を足せるのは本文を直せる人と同じ：全店共通は本部、店舗は trusted 以上か、修正案を出している本人
  const canAttach = k.storeId === null
    ? me?.adminScope === 'tenant'
    : isTrusted() || k.pendingEdits.some((p) => p.mine);
  const photos = photoSection(k.id, canAttach);
  // 確認できるのは trusted 以上。押したところだけを描き直す（写真や読んでいた位置を保つため）
  const canVerify = isTrusted() && k.status === 'published';
  const freshBox = h('div');
  const drawFresh = () => {
    clear(freshBox);
    freshBox.append(freshnessDetail(k, canVerify
      ? async () => {
          await api('POST', `/knowledge/${k.id}/verify`);
          k.verifiedAt = new Date().toISOString();
          k.verifiedBy = me!.name;
          toast('今も正しいと記録しました');
          drawFresh();
        }
      : undefined));
  };
  drawFresh();
  // ブックマーク：ほかの人が書いたものに、自分用の印を付ける。付いた数は、書いた本人にだけ届く
  const bookmarkBox = h('div', { class: 'bookmark-box' });
  const drawBookmark = () => {
    clear(bookmarkBox);
    if (k.status !== 'published') return;
    if (k.canBookmark) {
      const btn = h('button', { type: 'button', class: `secondary small bookmark${k.bookmarked ? ' bookmark-on' : ''}`, 'aria-pressed': k.bookmarked ? 'true' : 'false' },
        k.bookmarked ? 'ブックマーク済み' : 'ブックマークする');
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try {
          await api(k.bookmarked ? 'DELETE' : 'POST', `/knowledge/${k.id}/bookmark`);
          k.bookmarked = !k.bookmarked;
          toast(k.bookmarked ? 'ブックマークしました（ホームに出ます）' : 'ブックマークを外しました');
        } catch (e) {
          toast(e instanceof Error ? e.message : String(e));
        }
        drawBookmark();
      });
      bookmarkBox.append(btn);
    } else if ((k.bookmarkCount ?? 0) > 0) {
      bookmarkBox.append(h('p', { class: 'bookmark-count' }, `${k.bookmarkCount}人がブックマークしています`,
        h('span', { class: 'hint' }, '（書いたあなたにだけ見えています）')));
    }
  };
  drawBookmark();
  shell('home', h('article', { class: 'page knowledge' },
    h('button', { type: 'button', class: 'back', onclick: () => history.back() }, '戻る'),
    k.status === 'published' ? null
      // 却下されたものを「承認待ち」と出し続けない。直して出し直せることも伝える
      : k.draftState === 'rejected'
        ? h('p', { class: 'pending' }, 'この投稿は承認されませんでした。まだ公開されていません。直して出し直すと、もう一度承認待ちになります。')
        : h('p', { class: 'pending' }, '承認待ちです。承認されると全員に公開されます。'),
    pendingEditsBlock(k),
    h('h1', {}, k.title),
    h('div', { class: 'tag-row' }, ...k.tags.map((t) => tagChip(t, { onClick: () => { location.hash = `#/search?q=${encodeURIComponent('#' + t)}`; } }))),
    bookmarkBox,
    h('div', { class: 'body' }, ...k.body.split(/\n{2,}/).map((p) => h('p', {}, p))),
    photos.el,
    freshBox,
    h('div', { class: 'actions' },
      h('a', { href: `#/edit/${k.id}`, class: 'secondary' }, isTrusted() ? '編集する' : '修正を提案する')),
  ));
  disposeView = photos.dispose;
}

/** 「半年以上」「1年以上」など、サーバーが決めた日数の言い方 */
function staleLabel(): string {
  const days = getStaleDays();
  if (days % 365 === 0) return `${days / 365}年以上`;
  if (days === 180) return '半年以上';
  if (days % 30 === 0) return `${days / 30}か月以上`;
  return `${days}日以上`;
}

/**
 * 承認待ちの修正案を、**誰の案かまで出す**。中身は「見る」で開く。
 *
 * 隠していると、同じところを2人が別々に直して、承認のときに片方が黙って消える。
 * 先に相手の案を読めれば、それを踏まえて書けるし、待つこともできる。
 */
function pendingEditsBlock(k: Knowledge): HTMLElement | null {
  if (k.status !== 'published' || k.pendingEdits.length === 0) return null;
  const box = h('div', { class: 'pending' });
  box.append(h('p', {}, '修正案が承認を待っています。承認されるまで、下の本文は変わりません。'));
  for (const p of k.pendingEdits) {
    const who = p.mine ? 'あなた' : `${p.editedBy ?? '退職した人'}さん`;
    const shown = h('div', { class: 'body' });
    const btn = action('見る', 'secondary small', async () => {
      if (shown.childElementCount > 0) { shown.replaceChildren(); btn.textContent = '見る'; return; }
      const vs = await api<Array<{ version: number; title: string; body: string }>>('GET', `/knowledge/${k.id}/versions`);
      const v = vs.find((x) => x.version === p.version);
      shown.replaceChildren(...(v
        ? [h('h3', {}, v.title), ...v.body.split(/\n{2,}/).map((t) => h('p', {}, t))]
        : [h('p', {}, '見つかりませんでした')]));
      btn.textContent = '閉じる';
    });
    box.append(h('p', {}, `${who}の修正案（${relativeDate(p.editedAt)}）`, btn), shown);
  }
  box.append(h('p', { class: 'hint' },
    '同じところを直すときは、先にこれを読んでください。別々に直すと、どちらかが消えます。'));
  return box;
}

/**
 * 詳細画面の新しさの表示：誰がいつ更新し、誰がいつ確認したか。
 * onVerify があれば「今も正しい」を出す。中身を変えずに確認日だけを新しくできる。
 */
function freshnessDetail(k: Knowledge, onVerify?: () => Promise<void>): HTMLElement {
  const f = freshness(k.updatedAt, k.verifiedAt);
  return h('div', { class: 'fresh-detail' },
    h('p', {}, `最終更新：${relativeDate(k.updatedAt)}${k.updatedBy ? `（${k.updatedBy}さん）` : ''}`),
    f.verified ? h('p', {}, `内容の確認：${relativeDate(k.verifiedAt)}${k.verifiedBy ? `（${k.verifiedBy}さん）` : ''}`) : null,
    // 誰が通したかを出す。承認した人が内容に責任を持つ。
    // 最初に書いた人も出す：同じ人の下書きが何度も直されるなら、その人に教え直したほうが早い
    k.approvedBy ? h('p', {}, `承認：${relativeDate(k.approvedAt)}（${k.approvedBy}さん）`) : null,
    k.createdBy && k.createdBy !== k.updatedBy ? h('p', {}, `最初に書いた人：${k.createdBy}さん`) : null,
    f.stale ? h('p', { class: 'fresh-warn' }, `${staleLabel()}、更新も確認もされていません。今も正しいか社員に確かめてから案内してください。`) : null,
    // 古いものほど押してほしいので、古いときだけ目立たせる
    ...(onVerify ? [action(f.stale ? '今も正しい（確認日を更新）' : '今も正しい', f.stale ? 'primary' : 'secondary small', onVerify)] : []),
  );
}

// --- 書く（投稿・編集） ------------------------------------------------------------

async function loadAndEdit(id: string, stale: () => boolean): Promise<void> {
  try {
    const existing = await api<Knowledge>('GET', `/knowledge/${id}`);
    if (stale()) return;
    renderWrite(existing);
  } catch (e) {
    if (stale()) return;
    renderFatal(e);
  }
}

/**
 * 書きかけの保存。売場では接客で呼ばれて画面を離れたり、ブラウザがタブを捨てたりする。
 * タブを閉じれば消える sessionStorage に置く（端末に長く残したくない／共用端末で他の人に見せない）。
 * 使えない環境（プライベートモードなど）では、保存も復元も黙って諦める。
 */
interface Draft { title: string; body: string; tags: string[] }

function draftStore(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function readDraft(key: string): Draft | null {
  try {
    const raw = draftStore()?.getItem(key);
    if (!raw) return null;
    const d = JSON.parse(raw) as Partial<Draft>;
    if (typeof d.title !== 'string' || typeof d.body !== 'string' || !Array.isArray(d.tags)) return null;
    return { title: d.title, body: d.body, tags: d.tags.filter((t): t is string => typeof t === 'string') };
  } catch {
    return null;
  }
}

function writeDraft(key: string, d: Draft | null): void {
  try {
    if (d) draftStore()?.setItem(key, JSON.stringify(d));
    else draftStore()?.removeItem(key);
  } catch {
    // 保存できなくても書く操作は止めない
  }
}

function renderWrite(existing: Knowledge | null): void {
  const draftKey = `misenare.draft.${existing?.id ?? 'new'}`;
  const initial: Draft = { title: existing?.title ?? '', body: existing?.body ?? '', tags: existing ? [...existing.tags] : [] };
  // 開いたときの内容と同じなら戻すものは無い（編集を開いただけの保存は残さない）
  const saved = readDraft(draftKey);
  const draft = saved && JSON.stringify(saved) !== JSON.stringify(initial) ? saved : null;
  const tags: string[] = draft ? [...draft.tags] : [...initial.tags];
  const title = h('input', { id: 'title', type: 'text', maxlength: 100, value: draft?.title ?? initial.title, placeholder: '例：冷蔵庫のリサイクル料金', required: true });
  const body = h('textarea', { id: 'body', rows: 8, placeholder: '手順や注意点。お客様への伝え方なども' });
  body.value = draft?.body ?? initial.body;
  const keepDraft = () => {
    const now: Draft = { title: title.value, body: body.value, tags: [...tags] };
    writeDraft(draftKey, JSON.stringify(now) === JSON.stringify(initial) ? null : now);
  };
  const tagField = h('input', { id: 'tag', type: 'text', placeholder: '#を付けずに入力してもOK', autocomplete: 'off', enterkeyhint: 'done' });
  const tagList = h('div', { class: 'tag-row' });
  const suggest = h('div', { class: 'suggest', hidden: true });
  const proposals = h('div', { class: 'proposals' });
  const message = h('p', { class: 'error', role: 'alert', hidden: true });

  const drawTags = () => {
    clear(tagList);
    tagList.append(...tags.map((t) => tagChip(t, { removable: true, onClick: () => { tags.splice(tags.indexOf(t), 1); drawTags(); drawProposals(); } })));
    keepDraft();
  };
  const addTag = (name: string) => {
    const n = name.replace(/^[#＃]+/, '').trim();
    if (n && !tags.includes(n)) tags.push(n);
    tagField.value = '';
    suggest.hidden = true;
    drawTags();
    drawProposals();
  };
  // 本文の単語のうち、既存タグと一致するものを「付けますか？」と提案する
  const drawProposals = () => {
    clear(proposals);
    if (!dict) return;
    const text = `${title.value} ${body.value}`.normalize('NFKC').toLowerCase();
    const found = dict.dictionary.matchPhrases(text)
      .map((id) => dict!.dictionary.tags.get(id)!.name)
      .filter((n, i, a) => a.indexOf(n) === i && !tags.includes(n))
      .slice(0, 5);
    if (found.length > 0) {
      proposals.append(h('span', { class: 'hint' }, '付けますか？'), ...found.map((n) => tagChip(n, { quiet: true, onClick: () => addTag(n) })));
    }
  };
  tagField.addEventListener('input', () => {
    if (!dict) return;
    renderSuggestions(suggest, tagField.value, dict.suggest(tagField.value, tags), (e) => addTag(e.tag.name), true);
  });
  tagField.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); if (tagField.value.trim()) addTag(tagField.value); }
  });
  title.addEventListener('input', () => { drawProposals(); keepDraft(); });
  body.addEventListener('input', () => { drawProposals(); keepDraft(); });

  const submit = async () => {
    message.hidden = true;
    if (tagField.value.trim()) addTag(tagField.value);
    if (tags.length === 0) { message.textContent = 'ハッシュタグを1つ以上付けてください。'; message.hidden = false; setTimeout(() => tagField.focus(), 0); return; } // 送信中は欄が無効なので、戻ってから合わせる
    // 開いたときの版を添える。開いたあとに別の人が直していたら、サーバーが止めて教えてくれる
    const payload = { title: title.value, body: body.value, tagNames: tags, ...(existing ? { baseVersion: existing.version } : {}) };
    try {
      type Saved = { id: string; published: boolean; readingsNeeded?: Array<{ id: string; name: string; proposed: string; candidates?: string[] }> };
      const r = existing
        ? await api<Saved>('PUT', `/knowledge/${existing.id}`, payload)
        : await api<Saved>('POST', `/stores/${storeId()}/knowledge`, payload);
      writeDraft(draftKey, null);
      // 一緒に選んでおいた写真を送る。メモはもう保存できているので、写真で失敗しても先へ進む
      // （開いた画面から足し直せる）
      const files = picker.files();
      let failed = 0;
      for (const [i, f] of files.entries()) {
        message.textContent = `写真を送っています（${i + 1}/${files.length}）…`;
        message.hidden = false;
        try { await uploadPhoto(r.id, f); } catch { failed += 1; }
      }
      message.hidden = true;
      toast(failed > 0
        ? `${r.published ? '公開しました' : '承認を依頼しました'}。写真が${failed}枚送れませんでした（開いた画面から足せます）`
        : r.published ? '公開しました' : '承認を依頼しました');
      await loadDictionary();
      const goOn = async () => { await loadDictionary(); location.hash = `#/k/${r.id}`; };
      // 新しいタグができたら、その場で読みを尋ねる。一番よく知っているのは、いま打った人。
      if (r.readingsNeeded && r.readingsNeeded.length > 0) {
        shell('write', askReadings(r.readingsNeeded, () => { void goOn(); }));
        return;
      }
      location.hash = `#/k/${r.id}`;
    } catch (err) {
      message.textContent = err instanceof Error ? err.message : String(err);
      message.hidden = false;
    }
  };

  drawTags();
  // 写真は、書きながら選んでおける。送るのは保存のあと（保存してはじめて、付ける先ができる）
  const picker = photoPicker();
  // 編集のときは、いま付いている写真も並べる。**写真を消せるのはこの画面だけ**
  // （読む画面に×を置くと、見ているだけのときに押してしまう）
  const canAttach = existing
    ? (existing.storeId === null ? me?.adminScope === 'tenant' : isTrusted() || existing.pendingEdits.some((p) => p.mine))
    : false;
  const current = existing ? photoSection(existing.id, canAttach, { allowDelete: true }) : null;
  const form = h('form', { class: 'page write' },
    existing ? null : writeSwitch('shared'),
    h('h1', {}, existing ? '共有メモを編集' : '共有メモを書く'),
    existing ? null : h('p', { class: 'hint' }, '店のみんなと共有するメモです。ナレッジとして、検索に出るようになります。'),
    draft ? h('p', { class: 'hint' }, '書きかけを戻しました') : null,
    h('label', { for: 'title' }, 'タイトル'), title,
    h('label', { for: 'body' }, '内容'), body,
    h('span', { class: 'label-like' }, '写真'),
    current ? current.el : picker.el,
    current && !canAttach ? picker.el : null,
    current && canAttach ? h('p', { class: 'hint' }, '写真の追加と削除は、保存を待たずにすぐ反映されます。') : null,
    h('label', { for: 'tag' }, 'ハッシュタグ'),
    tagList, tagField, suggest, proposals,
    message,
    h('button', { type: 'submit', class: 'primary' }, isTrusted() ? '公開する' : '承認を依頼する'),
    isTrusted() ? null : h('p', { class: 'note' }, 'trusted のメンバーが承認すると公開されます。'),
  );
  // 送信中は押し直せないようにする。連打で同じナレッジが2件公開されるのを防ぐ
  submitOnce(form, submit);
  shell('write', form);
  disposeView = () => { picker.dispose(); current?.dispose(); };
  drawProposals();
  (existing ? body : title).focus();
}

// --- バーコード -------------------------------------------------------------------

function renderScan(initialJan: string, stale: () => boolean): void {
  const field = h('input', { id: 'jan', type: 'text', inputmode: 'numeric', pattern: '[0-9]*', maxlength: 13, value: initialJan, placeholder: '4901234567894', autocomplete: 'off' });
  const out = h('div', { class: 'scan-result', 'aria-live': 'polite' });
  const video = h('video', { class: 'camera', playsinline: true, muted: true, hidden: true });
  const lookupButton = h('button', { type: 'button', class: 'secondary' }, '調べる');
  // 続けて調べたとき、最後に調べたものの結果だけを描く
  let lookupSeq = 0;
  const lookup = busyGuard(() => [lookupButton, field], async () => {
    const jan = field.value.replace(/\D/g, '');
    if (!jan) return;
    stopCamera(); // 数字で調べるなら、カメラはもう要らない
    history.replaceState(null, '', `#/scan?jan=${jan}`);
    const mine = ++lookupSeq;
    try {
      const r = await api<ScanResult>('GET', `/stores/${storeId()}/barcode/${jan}`);
      if (stale() || mine !== lookupSeq) return;
      renderScanResult(out, r);
    } catch (e) {
      if (stale() || mine !== lookupSeq) return;
      clear(out);
      out.append(h('p', { class: 'error', role: 'alert' }, e instanceof Error ? e.message : String(e)));
    }
  });
  // カメラで読む。端末が BarcodeDetector を持っていればそれを使い（Android の Chrome など）、
  // 無ければ（iPhone の Safari）自前の読み取り（ean.ts）で、画のまんなかの帯から読む。
  const Detector = (window as unknown as { BarcodeDetector?: new (o: { formats: string[] }) => { detect(v: HTMLVideoElement): Promise<Array<{ rawValue: string }>> } }).BarcodeDetector;
  const canCamera = typeof navigator.mediaDevices?.getUserMedia === 'function';
  const cameraHint = h('p', { class: 'hint', hidden: true }, 'バーコードを横向きにして、画面のまんなかに写してください。読めないときは、少し離すとピントが合います。');
  // カメラは押すたびに新しく掴むので、前の stream と読み取りのループを止めてから始める。
  // 止め忘れるとカメラが点いたままになり、電池も食う。画面を離れるときも止める（disposeView）
  let stream: MediaStream | null = null;
  let frame = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cameraSeq = 0;
  const stopCamera = () => {
    cameraSeq += 1; // 動いているループと、取得待ちの startCamera を無効にする
    cancelAnimationFrame(frame);
    clearTimeout(timer);
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
    video.srcObject = null;
    video.hidden = true;
    cameraHint.hidden = true;
  };
  const startCamera = async () => {
    if (!canCamera) return;
    stopCamera();
    const mine = cameraSeq;
    try {
      const got = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
      if (mine !== cameraSeq) { got.getTracks().forEach((t) => t.stop()); return; } // 待つ間に離れた・押し直された
      stream = got;
      video.srcObject = got;
      video.hidden = false;
      cameraHint.hidden = false;
      await video.play();
      if (mine !== cameraSeq) return;
      const found = (code: string) => {
        field.value = code;
        stopCamera();
        void lookup();
      };
      if (Detector) {
        const detector = new Detector({ formats: ['ean_13', 'ean_8'] });
        const tick = async () => {
          if (mine !== cameraSeq) return;
          const codes = await detector.detect(video).catch(() => []);
          if (mine !== cameraSeq) return;
          if (codes[0]) return found(codes[0].rawValue);
          frame = requestAnimationFrame(() => void tick());
        };
        void tick();
        return;
      }
      // 自前の読み取り。画のまんなかの帯（高さの4割）だけを切り出して、1秒に8回ほど試す。
      // 同じ数字が2回続けて読めたら採る（たまたま形が似た模様を、商品だと思わない）
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) throw new Error('canvas');
      let last = '';
      const tick = () => {
        if (mine !== cameraSeq) return;
        const vw = video.videoWidth, vh = video.videoHeight;
        if (vw > 0 && vh > 0) {
          const width = Math.min(vw, 1000);
          const bandHeight = Math.round(vh * 0.4);
          const height = Math.max(40, Math.round(bandHeight * (width / vw)));
          if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
          ctx.drawImage(video, 0, Math.round((vh - bandHeight) / 2), vw, bandHeight, 0, 0, width, height);
          const code = decodeImage(ctx.getImageData(0, 0, width, height));
          if (code) {
            if (code === last) return found(code);
            last = code;
          }
        }
        timer = setTimeout(tick, 120);
      };
      tick();
    } catch {
      if (mine === cameraSeq) stopCamera(); // play() などで失敗したとき、掴んだカメラを放す
      toast('カメラを使えませんでした。設定でカメラを許可するか、数字を入力してください');
    }
  };
  field.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); void lookup(); } });
  lookupButton.addEventListener('click', () => void lookup());
  shell('home', h('section', { class: 'page' },
    h('h1', {}, 'バーコードで調べる'),
    canCamera ? h('button', { type: 'button', class: 'primary', onclick: () => void startCamera() }, 'カメラで読み取る') : null,
    video,
    cameraHint,
    h('label', { for: 'jan' }, 'JANコード（バーコードの下の数字）'),
    h('div', { class: 'search-bar' }, field, lookupButton),
    out,
  ));
  disposeView = stopCamera;
  if (initialJan) void lookup();
}

function renderScanResult(out: HTMLElement, r: ScanResult): void {
  clear(out);
  if (r.status === 'unknown') {
    out.append(h('p', {}, 'この商品はまだ登録されていません。売場とタグを登録すると、次から関連するナレッジが出ます。'), productForm(r.janCode, null, out));
    return;
  }
  const p = r.product;
  out.append(
    h('div', { class: 'product' },
      h('p', { class: 'product-name' }, p.name),
      h('p', { class: 'product-meta' }, [p.maker, p.area ? `売場：${p.area.name}` : '売場：未登録', `JAN ${p.janCode}`].filter(Boolean).join('　')),
      p.note ? h('p', {}, p.note) : null,
      p.pending ? h('p', { class: 'pending' }, '登録の承認待ちです') : null,
      h('div', { class: 'tag-row' }, ...p.tags.map((t) => tagChip(t, { quiet: true }))),
      h('button', { type: 'button', class: 'link', onclick: () => { clear(out); out.append(productForm(p.janCode, p, out)); } }, '売場やタグを直す')),
    r.related.length > 0 ? h('h2', {}, '関連するナレッジ') : h('p', {}, 'この商品に関係するナレッジはまだありません。'),
  );
  if (r.related.length > 0) out.append(hitList(r.related));
}

function productForm(janCode: string, existing: ProductCard | null, out: HTMLElement): HTMLElement {
  const name = h('input', { id: 'pname', type: 'text', maxlength: 100, value: existing?.name ?? '', placeholder: '例：東芝 冷凍冷蔵庫 GR-W600' });
  const maker = h('input', { id: 'pmaker', type: 'text', value: existing?.maker ?? '', placeholder: '例：東芝' });
  const note = h('input', { id: 'pnote', type: 'text', value: existing?.note ?? '', placeholder: '例：入口側の通路の奥' });
  const tags: string[] = existing ? [...existing.tags] : [];
  const tagField = h('input', { id: 'ptag', type: 'text', placeholder: '冷蔵庫、大型家電 など', autocomplete: 'off' });
  const tagList = h('div', { class: 'tag-row' });
  const suggest = h('div', { class: 'suggest', hidden: true });
  const message = h('p', { class: 'error', role: 'alert', hidden: true });
  const draw = () => { clear(tagList); tagList.append(...tags.map((t) => tagChip(t, { removable: true, onClick: () => { tags.splice(tags.indexOf(t), 1); draw(); } }))); };
  const add = (n: string) => { const v = n.replace(/^[#＃]+/, '').trim(); if (v && !tags.includes(v)) tags.push(v); tagField.value = ''; suggest.hidden = true; draw(); };
  tagField.addEventListener('input', () => { if (dict) renderSuggestions(suggest, tagField.value, dict.suggest(tagField.value, tags), (e) => add(e.tag.name), true); });
  tagField.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); if (tagField.value.trim()) add(tagField.value); } });
  draw();
  const submit = async () => {
    message.hidden = true;
    if (tagField.value.trim()) add(tagField.value);
    try {
      const r = existing
        ? await api<{ published: boolean }>('PATCH', `/stores/${storeId()}/products/${existing.id}`, { name: name.value, maker: maker.value || null, note: note.value || null, tagNames: tags })
        : await api<{ published: boolean }>('POST', `/stores/${storeId()}/products`, { janCode, name: name.value, maker: maker.value || null, note: note.value || null, tagNames: tags });
      toast(r.published ? '保存しました' : '承認待ちにしました');
      renderScanResult(out, await api<ScanResult>('GET', `/stores/${storeId()}/barcode/${janCode}`));
    } catch (err) {
      message.textContent = err instanceof Error ? err.message : String(err);
      message.hidden = false;
    }
  };
  const form = h('form', { class: 'write' },
    h('label', { for: 'pname' }, '商品名'), name,
    h('label', { for: 'pmaker' }, 'メーカー'), maker,
    h('label', { for: 'pnote' }, '売場のメモ'), note,
    h('label', { for: 'ptag' }, 'ハッシュタグ'), tagList, tagField, suggest,
    message,
    h('button', { type: 'submit', class: 'primary' }, existing ? '保存する' : '登録する'));
  submitOnce(form, submit); // 連打で同じ商品を2回送らない
  return form;
}

// --- 承認・管理（trusted / administrator） --------------------------------------------

/**
 * 承認・管理の上3つの一覧の枠。取れたものだけ描き、失敗した枠にだけ赤字を出す。
 * reload は、行の操作が 409 になった（他の人が先に操作した）あとに、その一覧だけ取り直すために使う。
 */
interface ListFrame<T> {
  box: HTMLElement;
  apply: (r: PromiseSettledResult<T>) => void;
  reload: () => Promise<void>;
  fetcher: () => Promise<T>;
}

function listFrame<T>(fetcher: () => Promise<T>, draw: (items: T) => Node[]): ListFrame<T> {
  const box = h('div');
  const apply = (r: PromiseSettledResult<T>) => {
    clear(box);
    if (r.status === 'fulfilled') box.append(...draw(r.value));
    else box.append(h('p', { class: 'error', role: 'alert' }, r.reason instanceof Error ? r.reason.message : String(r.reason)));
  };
  const reload = async () => {
    try {
      apply({ status: 'fulfilled', value: await fetcher() });
    } catch (reason) {
      apply({ status: 'rejected', reason });
    }
  };
  return { box, apply, reload, fetcher };
}

async function renderManage(stale: () => boolean): Promise<void> {
  if (!isTrusted()) { location.hash = '#/home'; return; }
  const section = h('section', { class: 'page manage' }, h('h1', {}, '承認・管理'));
  shell('settings', section);
  const sid = storeId();
  type PendingRow = { id: string; version: number; title: string; edited_by: string; is_new: boolean };
  type StaleRow = { id: string; title: string; verified_at: string | null };
  const pendingList: ListFrame<PendingRow[]> = listFrame(
    () => api<PendingRow[]>('GET', `/stores/${sid}/pending`),
    (pending) => countedList('承認待ち', pending, (p, remove) =>
      h('li', { class: 'row' },
        h('a', { href: `#/k/${p.id}` }, p.title),
        h('span', { class: 'hint' }, `${p.edited_by}さん・${p.is_new ? '新規' : '修正'}`),
        h('span', { class: 'row-actions' },
          action('公開する', 'primary small', async () => { await api('POST', `/knowledge/${p.id}/versions/${p.version}/approve`); toast('公開しました'); remove(); }, () => pendingList.reload()),
          action('却下する', 'secondary small', async () => { await api('POST', `/knowledge/${p.id}/versions/${p.version}/reject`); toast('却下しました'); remove(); }, () => pendingList.reload()))), 'h2'));
  const zeroList = listFrame(
    () => api<Array<{ query: string; times: number }>>('GET', `/stores/${sid}/zero-hits`),
    (zero) => [
      h('h2', {}, '見つからなかった検索'),
      zero.length === 0 ? h('p', { class: 'hint' }, 'ありません。') : h('ul', { class: 'rows' }, ...zero.slice(0, 20).map((z) =>
        h('li', { class: 'row' }, h('span', {}, z.query), h('span', { class: 'hint' }, `${z.times}回`)))),
    ]);
  const staleList: ListFrame<StaleRow[]> = listFrame(
    () => api<StaleRow[]>('GET', `/stores/${sid}/stale`),
    (old) => countedList(`${staleLabel()}確認されていないナレッジ`, old, (s, remove) =>
      h('li', { class: 'row' },
        h('a', { href: `#/k/${s.id}` }, s.title),
        h('span', { class: 'row-actions' },
          action('今も正しい', 'secondary small', async () => { await api('POST', `/knowledge/${s.id}/verify`); toast('確認済みにしました'); remove(); }, () => staleList.reload()))), 'h2'));
  // 3本は互いに待たない。1本が失敗しても、取れたものは出す
  const [a, b, c] = await Promise.allSettled([pendingList.fetcher(), zeroList.fetcher(), staleList.fetcher()]);
  if (stale()) return; // 待つ間に別の画面へ移っていた
  pendingList.apply(a);
  zeroList.apply(b);
  staleList.apply(c);
  section.append(pendingList.box, zeroList.box, staleList.box);
  section.append(productPanel(storeId()), readingPanel(), tagPanel(isAdmin()), importPanel(storeId()));
  // 書き出しは会社全体のデータなので、本部（会社全体の管理者）にだけ出す
  if (me!.adminScope === 'tenant') section.append(exportPanel());
  if (isAdmin()) {
    section.append(
      accessRequestPanel(me!.stores, storeId(), () => { void refreshBadges().then(updateManageCount); }),
      staffPanel(storeId(), { id: me!.id, adminScope: me!.adminScope }),
      inviteForm(),
    );
    // 会社のアカウントの設定は本部だけ（会社全体に効くため）
    if (me!.adminScope === 'tenant') section.append(ssoPanel(me!.stores));
  }
}

// --- スタッフ1人の管理 ----------------------------------------------------------
//
// 一覧の行に置くと混み合う操作（役割・名前・メールアドレス・端末）を、1人ずつの画面にまとめる。
// 開けるのは、その人を管理できる人だけ（サーバーが確かめる）。

interface StaffDetail {
  id: string; name: string; trust_level: 'visitor' | 'trusted'; admin_scope: 'none' | 'store' | 'tenant';
  status: 'active' | 'disabled'; email: string | null; via_sso: boolean;
  stores: Array<{ id: string; name: string }>;
  deviceList: Device[];
  isSelf: boolean;
}

async function renderStaff(userId: string, stale: () => boolean): Promise<void> {
  if (!isAdmin()) { location.hash = '#/home'; return; }
  const section = h('section', { class: 'page' });
  shell('settings', section);
  const draw = async (): Promise<void> => {
    let u: StaffDetail;
    try {
      u = await api<StaffDetail>('GET', `/users/${userId}`);
    } catch (e) {
      if (stale()) return;
      clear(section);
      section.append(
        h('a', { href: '#/manage', class: 'back' }, '承認・管理へ戻る'),
        h('p', { class: 'error', role: 'alert' }, e instanceof Error ? e.message : String(e)));
      return;
    }
    if (stale()) return;
    clear(section);
    const patch = async (body: Record<string, unknown>, done: string): Promise<void> => {
      await api('PATCH', `/users/${u.id}`, body);
      toast(done);
      await draw();
    };
    section.append(
      h('a', { href: '#/manage', class: 'back' }, '承認・管理へ戻る'),
      h('h1', {}, u.name, u.status === 'disabled' ? h('span', { class: 'pending' }, '（無効）') : null),
      h('p', { class: 'hint' }, [roleLabel(u), u.stores.length > 0 ? u.stores.map((x) => x.name).join('・') : '店舗に所属していません', u.via_sso ? '会社アカウント' : ''].filter(Boolean).join('・')),
    );

    // 名前
    const nameInput = h('input', { id: 'staff-name', type: 'text', maxlength: 40, value: u.name });
    section.append(
      h('h2', {}, '名前'),
      h('p', { class: 'hint' }, '投稿や承認に出る名前です。'),
      h('label', { for: 'staff-name' }, '名前'), nameInput,
      action('名前を直す', 'secondary', async () => { await patch({ name: nameInput.value }, '名前を直しました'); }));

    // 自分の権限・状態は変えられない（締め出し防止）。本部が自分の画面を開いたときは、名前だけ
    if (u.isSelf) {
      section.append(h('p', { class: 'note' }, '自分の役割と状態は、自分では変えられません。端末とメールアドレスは「この端末の設定」から。'));
      return;
    }

    // 役割（本部だけが変えられる）
    if (me!.adminScope === 'tenant') {
      const to = (scope: 'none' | 'store' | 'tenant', label: string, question: string, done: string): HTMLElement =>
        confirmAction(label, 'secondary', question, async () => { await patch({ adminScope: scope }, done); });
      section.append(
        h('h2', {}, '役割'),
        h('p', {}, `いまは「${roleLabel(u)}」です。`),
        h('div', { class: 'actions' },
          u.admin_scope !== 'store' ? to('store', '店長にする', `${u.name}さんを、所属している店舗の店長にします。スタッフの招待と無効化、承認ができるようになります。`, '店長にしました') : null,
          u.admin_scope !== 'tenant' ? to('tenant', '本部にする', `${u.name}さんを本部にします。全店舗の管理と、店長・本部の変更ができるようになります。`, '本部にしました') : null,
          u.admin_scope !== 'none' ? to('none', '一般のスタッフにする', `${u.name}さんから、管理の権限を外します。`, '一般のスタッフにしました') : null),
      );
    }
    if (u.admin_scope === 'none' && u.status === 'active') {
      section.append(
        h('h2', {}, '投稿の扱い'),
        h('p', {}, u.trust_level === 'trusted' ? 'trusted：投稿がすぐ公開され、ほかの人の投稿を承認できます。' : 'visitor：投稿は、承認されてから公開されます。'),
        action(u.trust_level === 'trusted' ? 'visitor に戻す' : 'trusted にする', 'secondary', async () => {
          const next = u.trust_level === 'trusted' ? 'visitor' : 'trusted';
          await patch({ trustLevel: next }, next === 'trusted' ? 'trusted にしました' : 'visitor に戻しました');
        }));
    }

    // 状態
    section.append(
      h('h2', {}, '利用の状態'),
      u.status === 'active'
        ? confirmAction('無効にする', 'secondary', `${u.name}さんの端末がすぐ使えなくなります。`, async () => { await patch({ status: 'disabled' }, '無効にしました'); })
        : action('有効に戻す', 'secondary', async () => { await patch({ status: 'active' }, '有効に戻しました'); }));

    // メールアドレス（外すことだけできる。別のアドレスは、本人が自分で確認して登録する）
    section.append(
      h('h2', {}, 'メールアドレス'),
      u.email
        ? h('p', {}, `登録中：${u.email}`)
        : h('p', { class: 'hint' }, '登録されていません（本人が「この端末の設定」から登録します）。'));
    if (u.email) {
      section.append(confirmAction('登録を外す', 'secondary', `${u.name}さんは、メールのリンクで入り直せなくなります。`,
        async () => { await patch({ email: null }, '登録を外しました'); }));
    }

    // 端末
    const out = h('div', { class: 'invite-out', 'aria-live': 'polite' });
    section.append(
      h('h2', {}, '端末'),
      u.deviceList.length === 0
        ? h('p', { class: 'hint' }, 'いま入っている端末はありません。')
        : h('ul', { class: 'rows' }, ...u.deviceList.map((d) => h('li', { class: 'row' },
            h('span', {}, d.deviceName ?? '名前のない端末'),
            h('span', { class: 'hint' }, [deviceOrigin(d), `${relativeDate(d.createdAt)}に登録`, `最後に使った日 ${relativeDate(d.lastUsedAt)}`].filter(Boolean).join('・')),
            h('span', { class: 'row-actions' },
              confirmAction('止める', 'secondary small', `${d.deviceName ?? 'この端末'}を止めます。その端末からは使えなくなります。`,
                async () => { await api('DELETE', `/sessions/${d.id}`); toast('止めました'); await draw(); }))))),
    );
    if (u.status === 'active') {
      section.append(
        h('p', { class: 'hint' }, '機種変更や紛失のときは、新しい端末を足せます。足したことは、本人のほかの端末に知らされます。'),
        action('端末を足す（QR・リンクを作る）', 'secondary', async () => {
          // 所属している店舗の招待として出す。店舗に所属しない本部の人は、店舗なしで出す
          const store = u.stores.some((x) => x.id === storeId()) ? storeId() : u.stores[0]?.id ?? null;
          const r = await api<{ token: string }>('POST', '/invitations', { storeId: store, userId: u.id });
          showInvite(out, r.token, u.name, `${u.name}さんの新しい端末でこのQRコードを読み取ってもらってください（1回限り・72時間有効）。読み取った端末は、${u.name}さんとして入ります。`);
        }),
        out);
    }
  };
  await draw();
}

/** 招待（または端末の追加）の鍵を、QRコードとリンクで見せる */
function showInvite(out: HTMLElement, token: string, who: string, lead: string): void {
  const link = `${location.origin}${location.pathname}#invite=${encodeURIComponent(token)}`;
  clear(out);
  const qr = h('div', { class: 'qr' });
  qr.innerHTML = qrToSvg(encodeQr(link), { label: `${who}さんの招待QRコード` });
  out.append(
    h('p', {}, lead),
    qr,
    h('textarea', { rows: 3, readonly: true, class: 'invite-link' }, link),
    h('div', { class: 'actions' },
      h('button', { type: 'button', class: 'secondary', onclick: async () => { await navigator.clipboard.writeText(link).catch(() => {}); toast('コピーしました'); } }, 'リンクをコピー'),
      h('button', { type: 'button', class: 'secondary', onclick: () => printQr(who, qr.innerHTML) }, '印刷する')));
}

function inviteForm(): HTMLElement {
  const name = h('input', { id: 'iname', type: 'text', maxlength: 40, placeholder: '例：佐藤' });
  const trusted = h('input', { id: 'itrusted', type: 'checkbox' });
  const out = h('div', { class: 'invite-out', 'aria-live': 'polite' });
  // 店長・本部として招けるのは本部だけ。本部には、役割を選ぶ欄を出す
  const canPickRole = me!.adminScope === 'tenant';
  const role = h('select', { id: 'irole' },
    h('option', { value: 'none' }, '一般のスタッフ'),
    h('option', { value: 'store' }, '店長（この店舗の管理者）'),
    h('option', { value: 'tenant' }, '本部（会社全体の管理者）'));
  const trustedRow = h('label', { class: 'check' }, trusted, '最初から trusted にする（投稿がすぐ公開される）');
  role.addEventListener('change', () => { trustedRow.hidden = role.value !== 'none'; });
  /** 招待に付ける権限。店長・本部は承認もできる立場なので trusted。本部は店舗に所属させない */
  const grant = (): Record<string, unknown> => {
    const picked = canPickRole ? role.value : 'none';
    return {
      storeId: picked === 'tenant' ? null : storeId(),
      trustLevel: picked !== 'none' || trusted.checked ? 'trusted' : 'visitor',
      ...(picked !== 'none' ? { adminScope: picked } : {}),
    };
  };
  const submit = async () => {
    try {
      const who = name.value;
      const r = await api<{ token: string; expiresAt: string }>('POST', '/invitations', { ...grant(), name: who });
      showInvite(out, r.token, who, `${who}さんのスマホでこのQRコードを読み取ってもらってください（1回限り・72時間有効）。`);
      name.value = '';
    } catch (err) {
      clear(out);
      out.append(h('p', { class: 'error', role: 'alert' }, err instanceof Error ? err.message : String(err)));
    }
  };
  const email = h('input', { id: 'iemail', type: 'email', autocomplete: 'off', placeholder: 'you@example.co.jp' });
  // QR を見せる代わりに、同じ招待リンクをメールで送る。パスワードは作らない。
  const sendMail = async () => {
    clear(out);
    try {
      const r = await api<{ sent: boolean }>('POST', '/invitations/email', { ...grant(), name: name.value, email: email.value });
      if (r.sent) {
        out.append(h('p', {}, `${email.value} に招待リンクを送りました（1回限り・72時間有効）。`));
        name.value = ''; email.value = '';
      } else {
        out.append(h('p', { class: 'error', role: 'alert' }, '送信できませんでした。サーバーのメール設定を確かめてください。'));
      }
    } catch (err) {
      out.append(h('p', { class: 'error', role: 'alert' }, err instanceof Error ? err.message : String(err)));
    }
  };
  const form = h('form', { class: 'write' },
    h('h2', {}, 'スタッフを招待する'),
    h('label', { for: 'iname' }, '名前'), name,
    ...(canPickRole ? [h('label', { for: 'irole' }, '役割'), role] : []),
    trustedRow,
    h('button', { type: 'submit', class: 'primary' }, 'QR・招待リンクを作る'),
    h('label', { for: 'iemail' }, 'メールで送る場合の宛先（任意）'), email,
    h('button', { type: 'button', class: 'secondary', onclick: () => void sendMail() }, 'メールで招待を送る'),
    out);
  submitOnce(form, submit); // 連打で招待が何本もできないように
  return form;
}

/** 招待QRコードを1枚だけ別の窓で開いて印刷する（休憩室に貼る・手渡しする用） */
function printQr(who: string, svg: string): void {
  const w = window.open('', '_blank', 'width=480,height=640');
  if (!w) { toast('印刷用の画面を開けませんでした。ブラウザの設定を確かめてください。'); return; }
  // 名前は HTML に埋めず、DOM として組み立てる（文字列連結だと名前に書いたタグがそのまま動く）
  const d = w.document;
  d.open();
  d.write('<!doctype html><html lang="ja"><head><meta charset="utf-8"></head><body></body></html>');
  d.close();
  const title = d.createElement('title');
  title.textContent = `${who}さんの招待`;
  const style = d.createElement('style');
  style.textContent = 'body{font-family:system-ui,sans-serif;text-align:center;padding:24px}'
    + 'svg{width:min(80vw,320px);height:auto}p{font-size:14px;color:#333}';
  d.head.append(title, style);
  const h1 = d.createElement('h1');
  h1.textContent = `${who}さん`;
  const qr = d.createElement('div');
  qr.innerHTML = svg; // 自分で作った SVG（packages/qr）。利用者の入力は <title> でエスケープ済み
  const p = d.createElement('p');
  p.textContent = 'スマホのカメラで読み取ってください（1回限り・72時間有効）';
  d.body.append(h1, qr, p);
  w.focus();
  w.print();
}

// 想定外の失敗（捕まえ損ねた例外・待たれていない Promise）で画面が黙ったままにならないようにする。
// 連続で起きる（ループ中の失敗など）と toast が積み重なるので、3 秒は再表示しない
let lastCrashToast = 0;
function crashToast(): void {
  const now = Date.now();
  if (now - lastCrashToast < 3000) return;
  lastCrashToast = now;
  toast('画面で問題が起きました。もう一度お試しください');
}
window.addEventListener('unhandledrejection', (ev) => {
  console.error('unhandledrejection', ev.reason);
  crashToast();
});
window.addEventListener('error', (ev) => {
  console.error('error', ev.error ?? ev.message);
  crashToast();
});

void boot();
