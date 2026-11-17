// 運営者の管理画面。フレームワークなし・ビルドなし（このファイルをそのまま配る）。
// 画面に出す文字はすべて textContent で入れる（会社名などをそのまま HTML にしない）。
'use strict';

const KEY = 'tsugigami.operator';
// 料金は店舗数にかかわらず一律なので、プランは「試用」か「契約」だけ
const PLANS = [['trial', '試用'], ['standard', '契約']];
const planLabel = (plan) => (PLANS.find(([value]) => value === plan) || [plan, plan])[1];
const view = document.getElementById('view');
const who = document.getElementById('who');
const nav = document.getElementById('nav');
const toastBox = document.getElementById('toast');

// ログインの鍵は、このタブの間だけ覚える（sessionStorage）。タブを閉じれば消える。
// 同じ住所で動くアプリ本体の画面からは、別のタブの sessionStorage は読めない。
const store = {
  get token() { try { return sessionStorage.getItem(KEY); } catch { return null; } },
  set token(v) { try { if (v === null) sessionStorage.removeItem(KEY); else sessionStorage.setItem(KEY, v); } catch { /* 保存できなくても、この画面の間は使える */ } },
};
// 前の版は localStorage に置いていた。残っていれば消す
try { localStorage.removeItem(KEY); } catch { /* 触れなくても困らない */ }
let memoryToken = store.token;
let me = null;

function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k in el && k !== 'list') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

function toast(text) {
  toastBox.textContent = text;
  toastBox.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { toastBox.hidden = true; }, 2600);
}

class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function api(method, path, body) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (memoryToken) headers.authorization = `Bearer ${memoryToken}`;
  let res;
  try {
    res = await fetch(`/api/operator${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  } catch {
    throw new ApiError(0, '通信できませんでした。もう一度お試しください');
  }
  let data = null;
  try { data = await res.json(); } catch { /* 本文なし */ }
  if (res.status === 401 && memoryToken && !path.startsWith('/auth/')) {
    signOutLocally();
    route();
    throw new ApiError(401, 'ログインし直してください');
  }
  if (!res.ok) throw new ApiError(res.status, (data && data.message) || `エラーが発生しました（${res.status}）`);
  return data;
}

function signOutLocally() {
  memoryToken = null;
  store.token = null;
  me = null;
  renderWho();
}

function renderWho() {
  who.replaceChildren();
  if (nav) nav.hidden = !me;
  if (!me) return;
  who.append(h('span', {}, me.email), h('button', { type: 'button', class: 'link', onclick: async () => {
    await api('POST', '/auth/logout').catch(() => {});
    signOutLocally();
    location.hash = '#/';
    route();
  } }, 'ログアウト'));
}

/** 送信ボタンを押している間は二重に走らせず、失敗は err に出す */
function guarded(button, err, fn) {
  return async (e) => {
    if (e) e.preventDefault();
    if (button.disabled) return;
    button.disabled = true;
    err.textContent = '';
    try { await fn(); } catch (x) { err.textContent = x instanceof Error ? x.message : String(x); } finally { button.disabled = false; }
  };
}

function field(label, input, hint) {
  const id = `f${field.n = (field.n || 0) + 1}`;
  input.id = id;
  return h('div', {}, h('label', { for: id }, label), input, hint ? h('p', { class: 'hint' }, hint) : null);
}

/** 続きを読むボタン。押すたびに load(next) を呼び、返ってきた next が無くなったら消える */
function moreButton(next, load) {
  const err = h('p', { class: 'error', role: 'alert' });
  const button = h('button', { type: 'button', class: 'small' }, 'さらに前を見る');
  const box = h('div', { class: 'more' }, button, err);
  box.hidden = next === null || next === undefined;
  button.addEventListener('click', guarded(button, err, async () => {
    next = await load(next);
    box.hidden = next === null || next === undefined;
  }));
  return box;
}

function day(text) {
  if (!text) return '';
  const d = new Date(text.replace(' ', 'T').replace(/\+00$/, 'Z'));
  return Number.isNaN(d.getTime()) ? text : `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}
function moment(text) {
  const d = new Date(text.replace(' ', 'T').replace(/\+00$/, 'Z'));
  if (Number.isNaN(d.getTime())) return text;
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// --- ログイン ---------------------------------------------------------------

function renderLogin() {
  const email = h('input', { type: 'email', autocomplete: 'username', required: true });
  const password = h('input', { type: 'password', autocomplete: 'current-password', required: true });
  const code = h('input', { type: 'text', autocomplete: 'one-time-code', inputMode: 'numeric', maxLength: 24 });
  const err = h('p', { class: 'error', role: 'alert' });
  const submit = h('button', { type: 'submit', class: 'primary' }, 'ログイン');
  const form = h('form', { class: 'panel' }, field('メールアドレス', email), field('パスワード', password),
    field('確認コード', code, '2段階の確認を設定しているときだけ。認証アプリの6桁か、予備のコード。'),
    err, h('div', { class: 'actions' }, submit));
  form.addEventListener('submit', guarded(submit, err, async () => {
    const r = await api('POST', '/auth/login', { email: email.value, password: password.value, code: code.value });
    memoryToken = r.token;
    store.token = r.token;
    await route();
  }));

  const setupEmail = h('input', { type: 'email', autocomplete: 'username', required: true });
  const setupErr = h('p', { class: 'error', role: 'alert' });
  const setupDone = h('p', { class: 'hint', hidden: true }, '運営者のアドレスなら、設定用のリンクを送りました。届いたメールのリンクを開いてください（30分以内）。');
  const setupSubmit = h('button', { type: 'submit' }, '設定リンクを送る');
  const setup = h('form', { class: 'panel' },
    h('p', { class: 'hint' }, 'はじめて使うとき・パスワードを忘れたときは、運営者のメールアドレスにパスワード設定用のリンクを送ります。'),
    field('メールアドレス', setupEmail), setupErr, setupDone, h('div', { class: 'actions' }, setupSubmit));
  setup.addEventListener('submit', guarded(setupSubmit, setupErr, async () => {
    setupDone.hidden = true;
    await api('POST', '/auth/setup', { email: setupEmail.value });
    setupDone.hidden = false;
  }));

  view.replaceChildren(h('div', { class: 'narrow' }, h('h1', {}, '運営者ログイン'), form, h('h2', {}, 'パスワードの設定・再設定'), setup));
}

function renderSetup(token) {
  const p1 = h('input', { type: 'password', autocomplete: 'new-password', required: true, minLength: 10 });
  const p2 = h('input', { type: 'password', autocomplete: 'new-password', required: true, minLength: 10 });
  const err = h('p', { class: 'error', role: 'alert' });
  const submit = h('button', { type: 'submit', class: 'primary' }, 'このパスワードにする');
  const form = h('form', { class: 'panel' },
    field('新しいパスワード', p1, '10文字以上。ほかのサービスで使っていないものにしてください。'),
    field('もう一度', p2), err, h('div', { class: 'actions' }, submit));
  form.addEventListener('submit', guarded(submit, err, async () => {
    if (p1.value !== p2.value) throw new Error('2つのパスワードが一致しません');
    await api('POST', '/auth/password', { token, password: p1.value });
    signOutLocally();
    history.replaceState(null, '', location.pathname);
    toast('パスワードを設定しました。ログインしてください');
    renderLogin();
  }));
  view.replaceChildren(h('div', { class: 'narrow' }, h('h1', {}, 'パスワードの設定'), form));
}

// --- 会社の一覧 -------------------------------------------------------------

function inviteBox(invite, name) {
  const copy = h('button', { type: 'button', class: 'small', onclick: async () => {
    try { await navigator.clipboard.writeText(invite.url); toast('コピーしました'); } catch { toast('コピーできませんでした。長押しで選んでください'); }
  } }, 'リンクをコピー');
  return h('div', { class: 'invite' },
    h('b', {}, `${name}さんへの招待リンク`),
    h('code', {}, invite.url),
    copy,
    h('p', { class: 'hint' }, `本部の管理者として入るためのリンクです。1回限り・${invite.hours}時間有効。この画面を離れると、もう表示できません（出し直しはできます）。`));
}

async function renderList() {
  view.replaceChildren(h('p', { class: 'hint' }, '読み込んでいます…'));
  const [{ tenants }, log] = await Promise.all([api('GET', '/tenants'), api('GET', '/log')]);

  const list = h('ul', { class: 'tenants' }, tenants.map((t) => h('li', {}, h('a', { href: `#/t/${t.id}` },
    h('span', { class: 't-name' }, t.name),
    h('span', { class: t.status === 'active' ? 'badge' : 'badge stopped' }, t.status === 'active' ? '利用中' : '停止中'),
    h('span', { class: 't-meta' },
      h('span', { class: 'badge plan' }, planLabel(t.plan)),
      `店舗 ${t.stores}${t.contractedStores === null ? '' : `（契約 ${t.contractedStores}）`}・利用者 ${t.users}・ナレッジ ${t.knowledge}`,
      t.periodEnd ? `・期限 ${day(t.periodEnd)}` : '',
      `・${day(t.createdAt)}から`)))));

  const name = h('input', { type: 'text', required: true, maxLength: 80 });
  const storeName = h('input', { type: 'text', required: true, maxLength: 80 });
  const adminName = h('input', { type: 'text', required: true, maxLength: 80 });
  const plan = h('select', {}, PLANS.map(([value, label]) => h('option', { value }, label)));
  const err = h('p', { class: 'error', role: 'alert' });
  const made = h('div', {});
  const submit = h('button', { type: 'submit', class: 'primary' }, '会社を作る');
  const form = h('form', { class: 'panel' },
    h('div', { class: 'grid' },
      field('会社名', name), field('最初の店舗名', storeName),
      field('管理者の名前', adminName, 'この人あての招待リンクを出します'), field('プラン', plan)),
    err, h('div', { class: 'actions' }, submit), made);
  form.addEventListener('submit', guarded(submit, err, async () => {
    const r = await api('POST', '/tenants', { name: name.value, storeName: storeName.value, adminName: adminName.value, plan: plan.value });
    const box = inviteBox(r.invite, adminName.value.trim());
    toast('会社を作りました');
    await renderList();
    document.getElementById('made').replaceChildren(box, h('p', {}, h('a', { href: `#/t/${r.id}` }, 'この会社の画面を開く')));
  }));
  made.id = 'made';

  const logLine = (e) => h('li', {}, `${moment(e.at)}　`, h('b', {}, e.action), e.tenantName ? `　${e.tenantName}` : '', e.detail ? `　${e.detail}` : '');
  const logList = h('ul', { class: 'log' }, log.entries.map(logLine));

  view.replaceChildren(
    h('h1', {}, '会社'),
    me && !me.totp ? h('p', { class: 'notice' }, '2段階の確認がまだ設定されていません。いまはパスワードだけで入れます。', h('a', { href: '#/security' }, '「安全」で設定する')) : null,
    tenants.length === 0 ? h('p', { class: 'hint' }, 'まだ会社がありません。下から作れます。') : list,
    h('h2', {}, '新しい会社を作る'), form,
    h('h2', {}, '操作の記録'),
    log.entries.length === 0 ? h('p', { class: 'hint' }, 'まだありません。') : logList,
    moreButton(log.next, async (before) => {
      const r = await api('GET', `/log?before=${before}`);
      logList.append(...r.entries.map(logLine));
      return r.next;
    }));
}

// --- 会社の詳細 -------------------------------------------------------------

async function renderTenant(id) {
  view.replaceChildren(h('p', { class: 'hint' }, '読み込んでいます…'));
  paintTenant(await api('GET', `/tenants/${id}`));
}

function paintTenant(t) {
  const base = `/tenants/${t.id}`;
  const stopped = t.status !== 'active';

  // 基本と契約
  const name = h('input', { type: 'text', required: true, maxLength: 80, value: t.name });
  const plan = h('select', {}, PLANS.map(([value, label]) => h('option', { value, selected: value === t.plan }, label)));
  const contracted = h('input', { type: 'number', min: 0, step: 1, inputMode: 'numeric', value: t.contractedStores === null ? '' : String(t.contractedStores) });
  const periodEnd = h('input', { type: 'date', value: t.periodEnd || '' });
  const note = h('textarea', { maxLength: 2000, value: t.billingNote || '' });
  const customer = h('input', { type: 'text', maxLength: 200, value: t.billingCustomerId || '', autocomplete: 'off' });
  const subscription = h('input', { type: 'text', maxLength: 200, value: t.billingSubscriptionId || '', autocomplete: 'off' });
  const err = h('p', { class: 'error', role: 'alert' });
  const save = h('button', { type: 'submit', class: 'primary' }, '保存する');
  const form = h('form', { class: 'panel' },
    h('div', { class: 'grid' },
      field('会社名', name), field('プラン', plan),
      field('契約店舗数', contracted, `いまの店舗は ${t.stores}。空なら未設定`), field('有効期限', periodEnd, '空なら未設定')),
    field('メモ', note, '請求の方法や連絡先など、運営者だけが読む控え'),
    h('details', {}, h('summary', { class: 'hint' }, '決済サービスの ID（まだつないでいません）'),
      h('div', { class: 'grid' }, field('顧客 ID', customer), field('契約 ID', subscription))),
    h('p', { class: 'hint' }, 'プラン・契約店舗数・有効期限は、いまは控えだけで、アプリの動きは変わりません。'),
    err, h('div', { class: 'actions' }, save));
  form.addEventListener('submit', guarded(save, err, async () => {
    paintTenant(await api('PATCH', base, {
      name: name.value, plan: plan.value, contractedStores: contracted.value, periodEnd: periodEnd.value,
      billingNote: note.value, billingCustomerId: customer.value, billingSubscriptionId: subscription.value,
    }));
    toast('保存しました');
  }));

  // 店舗
  const storeErr = h('p', { class: 'error', role: 'alert' });
  const stores = h('ul', { class: 'rows' }, t.storeList.map((s) => {
    const input = h('input', { type: 'text', class: 'grow', maxLength: 80, value: s.name, 'aria-label': `${s.name} の店舗名` });
    const rename = h('button', { type: 'button', class: 'small' }, '名前を変える');
    rename.addEventListener('click', guarded(rename, storeErr, async () => {
      paintTenant(await api('PATCH', `${base}/stores/${s.id}`, { name: input.value }));
      toast('店舗名を変えました');
    }));
    const empty = s.members === 0 && s.knowledge === 0 && t.storeList.length > 1;
    const remove = h('button', { type: 'button', class: 'small danger', disabled: !empty, title: empty ? '' : '利用者やナレッジのある店舗・最後の1店舗は消せません' }, '消す');
    remove.addEventListener('click', guarded(remove, storeErr, async () => {
      paintTenant(await api('DELETE', `${base}/stores/${s.id}`));
      toast('店舗を消しました');
    }));
    return h('li', {}, input, h('span', { class: 'hint' }, `利用者 ${s.members}・ナレッジ ${s.knowledge}`), rename, remove);
  }));
  const newStore = h('input', { type: 'text', class: 'grow', maxLength: 80, required: true, placeholder: '新しい店舗の名前', 'aria-label': '新しい店舗の名前' });
  const addBtn = h('button', { type: 'submit', class: 'small' }, '店舗を足す');
  const addForm = h('form', { class: 'rows' }, h('li', {}, newStore, addBtn));
  addForm.addEventListener('submit', guarded(addBtn, storeErr, async () => {
    paintTenant(await api('POST', `${base}/stores`, { name: newStore.value }));
    toast('店舗を足しました');
  }));

  // 管理者
  const adminName = h('input', { type: 'text', class: 'grow', maxLength: 80, required: true, placeholder: '招待する人の名前', 'aria-label': '招待する人の名前' });
  const inviteBtn = h('button', { type: 'submit', class: 'small' }, '招待リンクを出す');
  const inviteErr = h('p', { class: 'error', role: 'alert' });
  const inviteOut = h('div', {});
  const inviteForm = h('form', { class: 'rows' }, h('li', {}, adminName, inviteBtn));
  inviteForm.addEventListener('submit', guarded(inviteBtn, inviteErr, async () => {
    const who = adminName.value.trim();
    inviteOut.replaceChildren(inviteBox(await api('POST', `${base}/admin-invite`, { name: adminName.value }), who));
    adminName.value = '';
  }));

  // 利用者（開いたときに読む）
  const usersErr = h('p', { class: 'error', role: 'alert' });
  const usersBox = h('div', {}, h('p', { class: 'hint' }, '読み込んでいます…'));
  const role = (u) => (u.adminScope === 'tenant' ? '本部' : u.adminScope === 'store' ? '店長' : u.trustLevel === 'trusted' ? 'スタッフ' : 'スタッフ（投稿は承認待ち）');
  const paintUsers = (users) => {
    if (users.length === 0) { usersBox.replaceChildren(h('p', { class: 'hint' }, 'まだだれもいません。')); return; }
    usersBox.replaceChildren(h('ul', { class: 'rows' }, users.map((u) => {
      const off = u.status !== 'active';
      const button = h('button', { type: 'button', class: off ? 'small' : 'small danger' }, off ? '戻す' : '止める');
      button.addEventListener('click', guarded(button, usersErr, async () => {
        paintUsers((await api('POST', `${base}/users/${u.id}/${off ? 'enable' : 'disable'}`)).users);
        toast(off ? `${u.name}さんを戻しました` : `${u.name}さんを止めました`);
      }));
      return h('li', {},
        h('span', { class: 'grow' }, u.name, off ? h('span', { class: 'badge stopped' }, '停止中') : null),
        h('span', { class: 'hint' }, [role(u), u.stores.length > 0 ? u.stores.join('・') : '店舗の所属なし', `端末 ${u.devices}`].join('／')),
        button);
    })));
  };
  api('GET', `${base}/users`).then((r) => paintUsers(r.users), (x) => { usersBox.replaceChildren(); usersErr.textContent = x instanceof Error ? x.message : String(x); });

  // 停止と削除
  const dangerErr = h('p', { class: 'error', role: 'alert' });
  const toggle = h('button', { type: 'button', class: stopped ? '' : 'danger' }, stopped ? '利用を再開する' : '利用を停止する');
  toggle.addEventListener('click', guarded(toggle, dangerErr, async () => {
    paintTenant(await api('POST', `${base}/${stopped ? 'resume' : 'suspend'}`));
    toast(stopped ? '再開しました' : '停止しました');
  }));
  const confirmName = h('input', { type: 'text', autocomplete: 'off', 'aria-label': '確認のための会社名' });
  const del = h('button', { type: 'submit', class: 'danger solid', disabled: true }, '完全に削除する');
  confirmName.addEventListener('input', () => { del.disabled = confirmName.value.trim() !== t.name; });
  const delForm = h('form', {},
    h('p', {}, `店舗 ${t.stores}・利用者 ${t.users}・ナレッジ ${t.knowledge} と写真が、すべて消えます。`, h('b', {}, '元に戻せません。')),
    field(`確認のため、会社名「${t.name}」を打ち込んでください`, confirmName),
    h('div', { class: 'actions' }, del));
  delForm.addEventListener('submit', guarded(del, dangerErr, async () => {
    await api('DELETE', base, { confirmName: confirmName.value });
    toast(`「${t.name}」を削除しました`);
    location.hash = '#/';
  }));

  view.replaceChildren(
    h('a', { class: 'back', href: '#/' }, '← 会社の一覧'),
    h('h1', {}, t.name, ' ', h('span', { class: stopped ? 'badge stopped' : 'badge' }, stopped ? '停止中' : '利用中')),
    h('p', { class: 'hint' }, `${day(t.createdAt)}に作成・利用者 ${t.users}・ナレッジ ${t.knowledge}`, stopped && t.suspendedAt ? `・${day(t.suspendedAt)}に停止` : ''),
    h('h2', {}, '基本と契約'), form,
    h('h2', {}, '店舗'), h('div', { class: 'panel' }, stores, addForm, storeErr),
    h('h2', {}, '本部の管理者'),
    h('div', { class: 'panel' },
      t.admins.length === 0
        ? h('p', { class: 'hint' }, 'まだだれも入っていません。招待リンクを出して渡してください。')
        : h('ul', { class: 'rows' }, t.admins.map((a) => h('li', {}, h('span', { class: 'grow' }, a.name), h('span', { class: 'hint' }, a.email || 'メール未登録')))),
      inviteForm, inviteErr, inviteOut),
    h('h2', {}, '利用者'),
    h('div', { class: 'panel' },
      h('p', { class: 'hint' }, '止めると、その人の端末はすべて使えなくなります（アプリの中で本部が「無効にする」のと同じ）。本部の人が辞めて、会社の中からは止められないときに使います。'),
      usersBox, usersErr),
    h('h2', {}, '停止と削除'),
    h('div', { class: 'panel danger-zone' },
      h('p', {}, stopped
        ? 'この会社はいま停止中です。利用者はログインしていても何もできません。データは残っています。'
        : '停止すると、この会社の利用者は何もできなくなります。データは残り、いつでも再開できます。'),
      h('div', { class: 'actions' }, toggle),
      stopped ? h('div', {}, h('h2', {}, '完全に削除'), delForm) : h('p', { class: 'hint' }, '完全に削除できるのは、停止してある会社だけです。'),
      dangerErr));
}

// --- 問い合わせ -------------------------------------------------------------

async function renderInquiries() {
  view.replaceChildren(h('p', { class: 'hint' }, '読み込んでいます…'));
  const first = await api('GET', '/inquiries');
  const card = (q) => h('li', { class: 'inquiry' },
    h('p', { class: 'inquiry-head' },
      h('b', {}, q.name), q.company ? `（${q.company}）` : '',
      q.mailed ? null : h('span', { class: 'badge stopped' }, 'メール未送信')),
    h('p', { class: 'hint' }, `${day(q.at)} ${moment(q.at).split(' ')[1] || ''}　`, h('span', { class: 'select' }, q.email)),
    h('p', { class: 'inquiry-body' }, q.message));
  const list = h('ul', { class: 'inquiries' }, first.inquiries.map(card));
  view.replaceChildren(
    h('h1', {}, '問い合わせ'),
    h('p', { class: 'hint' }, '紹介サイトのフォームから届いたものです。届いたときにメールでも知らせています。1年たつと消えます。'),
    first.unmailed > 0 ? h('p', { class: 'notice' }, `知らせのメールを送れなかったものが ${first.unmailed} 件あります（「メール未送信」の印）。ここでしか読めません。`) : null,
    first.inquiries.length === 0 ? h('p', { class: 'hint' }, 'まだありません。') : list,
    moreButton(first.next, async (before) => {
      const r = await api('GET', `/inquiries?before=${encodeURIComponent(before)}`);
      list.append(...r.inquiries.map(card));
      return r.next;
    }));
}

// --- 安全（2段階の確認・ログインの記録） -------------------------------------

/** QR コードを描く。rows は '0' と '1' の文字列の並び（サーバーが作る） */
function qrSvg(rows) {
  const NS = 'http://www.w3.org/2000/svg';
  const quiet = 4;
  const side = rows.length + quiet * 2;
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${side} ${side}`);
  svg.setAttribute('class', 'qr');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', '認証アプリで読み取る QR コード');
  svg.setAttribute('shape-rendering', 'crispEdges');
  const paper = document.createElementNS(NS, 'rect');
  paper.setAttribute('width', String(side));
  paper.setAttribute('height', String(side));
  paper.setAttribute('fill', '#fff');
  let d = '';
  rows.forEach((row, y) => { for (let x = 0; x < row.length; x++) if (row[x] === '1') d += `M${x + quiet} ${y + quiet}h1v1h-1z`; });
  const ink = document.createElementNS(NS, 'path');
  ink.setAttribute('d', d);
  ink.setAttribute('fill', '#000');
  svg.append(paper, ink);
  return svg;
}

function recoveryBox(codes) {
  const copy = h('button', { type: 'button', class: 'small', onclick: async () => {
    try { await navigator.clipboard.writeText(codes.join('\n')); toast('コピーしました'); } catch { toast('コピーできませんでした。長押しで選んでください'); }
  } }, 'まとめてコピー');
  return h('div', { class: 'invite' },
    h('b', {}, '予備のコード'),
    h('p', { class: 'hint' }, '認証アプリを使えないときに、確認コードの代わりに1本ずつ使えます（使ったものは消えます）。この画面を離れると、もう表示できません。パスワードとは別の場所に控えてください。'),
    h('ul', { class: 'codes' }, codes.map((c) => h('li', {}, c))),
    copy);
}

const OUTCOME = { ok: '入れた', password: 'パスワード違い', code: '確認コード違い', locked: '受け付け停止中' };

async function renderSecurity() {
  view.replaceChildren(h('p', { class: 'hint' }, '読み込んでいます…'));
  const [status, logins] = await Promise.all([api('GET', '/security'), api('GET', '/logins')]);
  const totpBox = h('div', {});
  const password = () => h('input', { type: 'password', autocomplete: 'current-password', required: true });
  const codeInput = () => h('input', { type: 'text', autocomplete: 'one-time-code', inputMode: 'numeric', maxLength: 24, required: true });

  const paintOff = () => {
    const pw = password();
    const err = h('p', { class: 'error', role: 'alert' });
    const start = h('button', { type: 'submit', class: 'primary' }, '設定を始める');
    const form = h('form', { class: 'panel' },
      h('p', {}, 'いまは、メールアドレスとパスワードだけで入れます。'),
      h('p', { class: 'hint' }, '2段階の確認を設定すると、ログインのたびに、スマートフォンの認証アプリ（Google Authenticator、Microsoft Authenticator、1Password など）に出る6桁も要るようになります。パスワードや、設定リンクの届くメールを見られただけでは、入れなくなります。'),
      field('いまのパスワード', pw, '本人の確認のため、もう一度入れてください。'),
      err, h('div', { class: 'actions' }, start));
    form.addEventListener('submit', guarded(start, err, async () => { paintSetup(await api('POST', '/security/totp/start', { password: pw.value })); }));
    totpBox.replaceChildren(form);
  };

  const paintSetup = (setup) => {
    const code = codeInput();
    const err = h('p', { class: 'error', role: 'alert' });
    const enable = h('button', { type: 'submit', class: 'primary' }, '有効にする');
    const form = h('form', { class: 'panel' },
      h('p', {}, h('b', {}, '1. '), '認証アプリに、この管理画面を登録します。'),
      h('div', { class: 'qr-row' },
        qrSvg(setup.qr),
        h('div', {},
          h('p', { class: 'hint' }, 'パソコンで開いているときは、スマートフォンの認証アプリで、この QR コードを読み取ってください。'),
          h('p', { class: 'hint' }, 'スマートフォンで開いているときは、下のボタンで認証アプリが開きます。'),
          h('p', {}, h('a', { class: 'button small', href: setup.uri }, '認証アプリで開く')),
          h('p', { class: 'hint' }, 'どちらも使えないときは、認証アプリに次の鍵を手で入れてください（時間ベース・6桁）。'),
          h('code', { class: 'select' }, setup.secret.replace(/(.{4})(?=.)/g, '$1 ')))),
      h('p', {}, h('b', {}, '2. '), '認証アプリに出た6桁を入れると、有効になります。'),
      field('確認コード', code),
      err, h('div', { class: 'actions' }, enable),
      h('p', { class: 'hint' }, '有効にするまでは、これまでどおりパスワードだけで入れます。'));
    form.addEventListener('submit', guarded(enable, err, async () => {
      const r = await api('POST', '/security/totp/enable', { code: code.value });
      if (me) me.totp = true;
      toast('2段階の確認を設定しました');
      paintOn({ totp: { enabled: true, enabledAt: new Date().toISOString(), recoveryCodesLeft: r.recoveryCodes.length } }, recoveryBox(r.recoveryCodes));
    }));
    totpBox.replaceChildren(form);
  };

  const paintOn = (st, extra) => {
    const out = h('div', {}, extra || null);
    const pw1 = password();
    const code1 = codeInput();
    const err1 = h('p', { class: 'error', role: 'alert' });
    const renew = h('button', { type: 'submit', class: 'small' }, '予備のコードを作り直す');
    const renewForm = h('form', {},
      h('p', { class: 'hint' }, '作り直すと、前の予備のコードは使えなくなります。'),
      h('div', { class: 'grid' }, field('いまのパスワード', pw1), field('確認コード', code1)),
      err1, h('div', { class: 'actions' }, renew));
    renewForm.addEventListener('submit', guarded(renew, err1, async () => {
      const r = await api('POST', '/security/recovery-codes', { password: pw1.value, code: code1.value });
      toast('予備のコードを作り直しました');
      paintOn({ totp: { ...st.totp, recoveryCodesLeft: r.recoveryCodes.length } }, recoveryBox(r.recoveryCodes));
    }));
    const pw2 = password();
    const code2 = codeInput();
    const err2 = h('p', { class: 'error', role: 'alert' });
    const off = h('button', { type: 'submit', class: 'small danger' }, '2段階の確認を外す');
    const offForm = h('form', {},
      h('p', { class: 'hint' }, '外すと、パスワードだけで入れる状態に戻ります。認証アプリを替えるときは、外してから設定し直してください。'),
      h('div', { class: 'grid' }, field('いまのパスワード', pw2), field('確認コード', code2)),
      err2, h('div', { class: 'actions' }, off));
    offForm.addEventListener('submit', guarded(off, err2, async () => {
      await api('POST', '/security/totp/disable', { password: pw2.value, code: code2.value });
      if (me) me.totp = false;
      toast('2段階の確認を外しました');
      paintOff();
    }));
    totpBox.replaceChildren(h('div', { class: 'panel' },
      h('p', {}, h('span', { class: 'badge' }, '設定済み'), ` ${day(st.totp.enabledAt)}から。ログインのたびに、認証アプリの6桁が要ります。`),
      h('p', { class: st.totp.recoveryCodesLeft <= 2 ? 'notice' : 'hint' }, `予備のコードは、あと ${st.totp.recoveryCodesLeft} 本あります。`),
      out,
      h('details', {}, h('summary', {}, '予備のコードを作り直す'), renewForm),
      h('details', {}, h('summary', {}, '2段階の確認を外す'), offForm),
      h('p', { class: 'hint' }, '認証アプリも予備のコードも無くしたときは、画面やメールからは外せません。サーバーの中から外します（手順は運用の手引きにあります）。')));
  };

  if (status.totp.enabled) paintOn(status); else paintOff();

  const line = (e) => h('li', {},
    `${moment(e.at)}　`, h('b', { class: e.outcome === 'ok' ? '' : 'bad' }, OUTCOME[e.outcome] || e.outcome),
    `　${e.email}　${e.known ? '前に入ったことのあるブラウザー' : '前に入ったことのないブラウザー'}`,
    h('span', { class: 'agent' }, [e.ip, e.agent].filter(Boolean).join('　')));
  const loginList = h('ul', { class: 'log' }, logins.entries.map(line));

  view.replaceChildren(
    h('h1', {}, '安全'),
    h('h2', {}, '2段階の確認'), totpBox,
    h('h2', {}, 'ログインの記録'),
    h('p', { class: 'hint' }, 'この管理画面へのログインを、入れたものも入れなかったものも残しています（90日ぶん）。前に入ったことのないブラウザーから入ると、メールでも知らせます。心当たりのないものがあれば、ログインの画面の「パスワードの設定・再設定」からパスワードを決め直してください。'),
    logins.entries.length === 0 ? h('p', { class: 'hint' }, 'まだありません。') : loginList,
    moreButton(logins.next, async (before) => {
      const r = await api('GET', `/logins?before=${before}`);
      loginList.append(...r.entries.map(line));
      return r.next;
    }));
}

// --- 振り分け ---------------------------------------------------------------

async function route() {
  const hash = location.hash;
  const setup = /^#setup=(.+)$/.exec(hash);
  if (setup) return renderSetup(decodeURIComponent(setup[1]));
  if (!memoryToken) { renderWho(); return renderLogin(); }
  try {
    if (!me) { me = await api('GET', '/me'); renderWho(); }
    const t = /^#\/t\/([0-9a-f-]{36})$/i.exec(hash);
    for (const a of nav ? nav.querySelectorAll('a') : []) a.classList.toggle('on', a.getAttribute('href') === (hash === '#/inquiries' || hash === '#/security' ? hash : '#/'));
    if (t) await renderTenant(t[1]);
    else if (hash === '#/inquiries') await renderInquiries();
    else if (hash === '#/security') await renderSecurity();
    else await renderList();
  } catch (x) {
    if (x instanceof ApiError && x.status === 401) return;
    view.replaceChildren(h('p', { class: 'error' }, x instanceof Error ? x.message : String(x)), h('p', {}, h('a', { href: '#/' }, '会社の一覧へ')));
  }
  window.scrollTo(0, 0);
}

window.addEventListener('hashchange', () => { void route(); });
void route();
