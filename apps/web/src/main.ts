// ミセナレ Web 版。スマホのブラウザで「探す・書く・バーコード」を使う。
// 画面は URL のハッシュで切り替える：#/home #/search?q= #/k/<id> #/write #/edit/<id> #/scan #/manage

import { api, ApiError, session, type Dictionary, type Hit, type Knowledge, type Me, type ProductCard, type ScanResult, type SearchResult } from './api.ts';
import { clear, freshness, freshnessBadge, getStaleDays, h, relativeDate, setStaleDays, tagChip, toast } from './dom.ts';
import { LocalDictionary, renderSuggestions, type PickEvent } from './tagInput.ts';
import { action, askReadings, countedList, importPanel, productPanel, readingPanel, staffPanel, tagPanel } from './manage.ts';
import { photoSection } from './photos.ts';
import { renderNotices, type Badges } from './notices.ts';
import { encodeQr, qrToSvg } from '@misenare/qr';

const root = document.getElementById('app')!;
let me: Me | null = null;
let dict: LocalDictionary | null = null;

// --- 起動 -------------------------------------------------------------------

async function boot(): Promise<void> {
  // 招待のQRコードは /app/#invite=<token> を開く
  const invite = /^#invite=(.+)$/.exec(location.hash);
  if (invite) return acceptInvite(decodeURIComponent(invite[1]!));
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
  if (me.stores.length === 0) return renderFatal(new Error('所属している店舗がありません。店長に確認してください。'));
  if (!session.storeId || !me.stores.some((s) => s.id === session.storeId)) session.storeId = me.stores[0]!.id;
  await loadDictionary();
  window.addEventListener('hashchange', route);
  route();
}

async function loadDictionary(): Promise<void> {
  try {
    dict = new LocalDictionary(await api<Dictionary>('GET', `/stores/${session.storeId}/tags/dictionary`));
  } catch {
    dict = null; // 辞書が取れなくても検索と投稿はできる（候補が出ないだけ）
  }
}

const storeId = () => session.storeId!;
const isTrusted = () => me !== null && (me.trustLevel === 'trusted' || me.adminScope !== 'none');
const isAdmin = () => me !== null && me.adminScope !== 'none';

// --- 招待の受け取り ------------------------------------------------------------

async function acceptInvite(token: string): Promise<void> {
  shell(null, h('section', { class: 'page center' }, h('p', {}, '端末を登録しています…')));
  try {
    const deviceName = navigator.userAgent.includes('iPhone') ? 'iPhone' : navigator.userAgent.includes('Android') ? 'Android' : 'ブラウザ';
    const r = await api<{ sessionToken: string }>('POST', '/auth/accept', { token, deviceName });
    session.token = r.sessionToken;
    history.replaceState(null, '', `${location.pathname}#/home`);
    await boot();
  } catch (e) {
    renderWelcome(e instanceof Error ? e.message : String(e));
  }
}

function renderWelcome(error?: string): void {
  const input = h('textarea', { id: 'invite', rows: 3, placeholder: '招待のリンクかコードを貼り付け', autocomplete: 'off' });
  const submit = () => {
    const v = input.value.trim();
    const m = /#invite=([^\s]+)/.exec(v);
    void acceptInvite(m ? decodeURIComponent(m[1]!) : v);
  };
  shell(null, h('section', { class: 'page welcome' },
    h('h1', { class: 'brand' }, 'ミセナレ'),
    h('p', { class: 'lead' }, '店のやり方を、接客の合間にすぐ探せます。'),
    h('p', {}, '使い始めるには、店長が発行する招待のQRコードをスマホのカメラで読み取ってください。'),
    error ? h('p', { class: 'error', role: 'alert' }, error) : null,
    h('label', { for: 'invite' }, 'リンクやコードを受け取った場合'),
    input,
    h('button', { type: 'button', class: 'primary', onclick: submit }, 'この端末を登録する'),
  ));
}

function renderFatal(e: unknown): void {
  shell(null, h('section', { class: 'page center' }, h('p', { class: 'error', role: 'alert' }, e instanceof Error ? e.message : String(e))));
}

// --- 画面の枠 -------------------------------------------------------------------

type Tab = 'home' | 'notices' | 'search' | 'write';

/** 前の画面が抱えている後始末（写真の表示用URLの解放など） */
let disposeView: (() => void) | null = null;

function shell(tab: Tab | null, ...content: Node[]): void {
  disposeView?.();
  disposeView = null;
  clear(root);
  const store = me?.stores.find((s) => s.id === session.storeId);
  const header = me ? h('header', { class: 'topbar' },
    me.stores.length > 1
      ? h('select', { class: 'store-select', 'aria-label': '店舗', onchange: async (e: Event) => {
          session.storeId = (e.target as HTMLSelectElement).value;
          await loadDictionary();
          route();
        } }, ...me.stores.map((s) => h('option', { value: s.id, ...(s.id === session.storeId ? { selected: true } : {}) }, s.name)))
      : h('span', { class: 'store-name' }, store?.name ?? ''),
    isTrusted() ? h('a', { href: '#/manage', class: 'topbar-link' }, '承認・管理') : null,
  ) : null;
  const nav = me ? h('nav', { class: 'tabbar', 'aria-label': '画面の切り替え' },
    navLink('#/home', 'ホーム', tab === 'home'),
    navLink('#/notices', '連絡', tab === 'notices', badgeCount()),
    navLink('#/search', '探す', tab === 'search'),
    navLink('#/write', '書く', tab === 'write'),
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
function badgeCount(): number {
  if (!badges) return 0;
  return badges.notices.unread + badges.notices.needsAck + badges.handovers.open;
}

/** 数を取り直して、タブの表示を更新する */
async function refreshBadges(): Promise<void> {
  if (!me || !session.storeId) return;
  try {
    badges = await api<Badges>('GET', `/stores/${storeId()}/badges`);
  } catch {
    badges = null;
  }
  const tab = document.querySelector('.tabbar a[href="#/notices"]');
  if (!tab) return;
  const existing = tab.querySelector('.tab-count');
  existing?.remove();
  const count = badgeCount();
  if (count > 0) tab.append(h('span', { class: 'tab-count', 'aria-label': `${count}件` }, String(count)));
}

// --- ルーティング ---------------------------------------------------------------

function route(): void {
  const hash = location.hash || '#/home';
  const [path, query] = hash.slice(1).split('?') as [string, string | undefined];
  const params = new URLSearchParams(query ?? '');
  const k = /^\/k\/([0-9a-f-]{36})$/.exec(path);
  const edit = /^\/edit\/([0-9a-f-]{36})$/.exec(path);
  if (path === '/search') return void renderSearch(params.get('q') ?? '');
  if (path === '/write') return renderWrite(null);
  if (edit) return void loadAndEdit(edit[1]!);
  if (k) return void renderKnowledge(k[1]!);
  if (path === '/scan') return renderScan(params.get('jan') ?? '');
  if (path === '/notices') return void renderNoticesTab();
  if (path === '/manage') return void renderManage();
  return void renderHome();
}

// --- ホーム ---------------------------------------------------------------------

async function renderHome(): Promise<void> {
  const tags = dict ? [...dict.dictionary.tags.values()].sort((a, b) => b.useCount - a.useCount).slice(0, 12) : [];
  const alert = h('div', { class: 'home-alert', hidden: true });
  shell('home', h('section', { class: 'page' },
    h('h1', {}, `${me!.name}さん`),
    alert,
    h('a', { href: '#/search', class: 'search-launch' }, 'タグや言葉で探す'),
    h('a', { href: '#/scan', class: 'secondary block' }, 'バーコードで商品を調べる'),
    tags.length > 0 ? h('h2', {}, 'よく使われるタグ') : null,
    tags.length > 0 ? h('div', { class: 'tag-row' }, ...tags.map((t) => tagChip(t.name, { onClick: () => { location.hash = `#/search?q=${encodeURIComponent('#' + t.name)}`; } }))) : null,
    me!.trustLevel === 'visitor' && !isAdmin()
      ? h('p', { class: 'note' }, 'あなたの投稿や修正は、trusted のメンバーが承認すると公開されます。')
      : null,
  ));
  // 連絡と引き継ぎの数は、ホームにも出す（出勤してすぐ気づけるように）
  await refreshBadges();
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
  if (parts.length > 0) {
    clear(alert);
    alert.append(h('a', { href: '#/notices' }, `${parts.join('、')}あります`));
    alert.hidden = false;
  }
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

// --- 探す -------------------------------------------------------------------------

async function renderSearch(initial: string): Promise<void> {
  const input = h('input', { type: 'search', id: 'q', value: initial, placeholder: '冷蔵庫 リサイクル', autocomplete: 'off', enterkeyhint: 'search', 'aria-label': '検索' });
  const suggest = h('div', { class: 'suggest', hidden: true });
  const results = h('div', { class: 'results', 'aria-live': 'polite' });
  let pendingPick: { suggestedTagId: string; pickedTagId: string } | null = null;
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
    void run();
  };
  const run = async () => {
    const q = input.value.trim();
    history.replaceState(null, '', `#/search?q=${encodeURIComponent(q)}`);
    const mine = ++seq;
    if (!q) { clear(results); return; }
    try {
      const r = await api<SearchResult>('GET', `/stores/${storeId()}/search?q=${encodeURIComponent(q)}`);
      if (mine !== seq) return;
      results.dataset.query = q;
      renderResults(results, r, q, (tag) => { input.value = `${input.value.trim()} #${tag} `; void run(); });
      if (pendingPick) {
        void api('POST', `/search-logs/${r.logId}/feedback`, pendingPick).catch(() => {});
        pendingPick = null;
      }
    } catch (e) {
      if (mine !== seq) return;
      clear(results);
      results.append(h('p', { class: 'error', role: 'alert' }, e instanceof Error ? e.message : String(e)));
    }
  };
  input.addEventListener('input', () => {
    updateSuggest();
    window.clearTimeout(timer);
    timer = window.setTimeout(() => void run(), 450);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); window.clearTimeout(timer); suggest.hidden = true; void run(); }
  });

  shell('search', h('section', { class: 'page' },
    h('div', { class: 'search-bar' }, input, h('a', { href: '#/scan', class: 'icon-button', 'aria-label': 'バーコードで調べる' }, 'JAN')),
    h('p', { class: 'hint' }, 'ひらがな・ローマ字でも候補が出ます（てれび／terebi → #テレビ）'),
    suggest,
    results,
  ));
  input.focus();
  if (initial) await run();
}

function renderResults(container: HTMLElement, r: SearchResult, q: string, addTag: (tag: string) => void): void {
  clear(container);
  if (r.hits.length === 0) {
    container.append(h('div', { class: 'empty' },
      h('p', {}, `「${q}」に当てはまるナレッジはまだありません。`),
      h('p', {}, '近くの社員に聞いて、教わった内容を残しておくと次の人が助かります。'),
      h('a', { href: '#/write', class: 'primary block' }, 'ナレッジを書く')));
    return;
  }
  if (r.chips.length > 0) {
    container.append(h('div', { class: 'tag-row chips' }, ...r.chips.map((c) => tagChip(`${c.name}`, { onClick: () => addTag(c.name), quiet: true }))));
  }
  container.append(hitList(r.hits, r.logId));
}

function hitList(hits: Hit[], logId?: number): HTMLElement {
  return h('ol', { class: 'hits' }, ...hits.map((hit) =>
    h('li', {},
      h('a', {
        href: `#/k/${hit.id}`,
        class: 'hit',
        onclick: () => { if (logId) void api('POST', `/search-logs/${logId}/feedback`, { openedKnowledgeId: hit.id }).catch(() => {}); },
      },
        h('span', { class: 'hit-title' }, hit.linked ? h('span', { class: 'linked' }, 'この商品の') : null, hit.title),
        h('span', { class: 'hit-snippet' }, hit.snippet),
        h('span', { class: 'hit-meta' }, ...hit.tags.slice(0, 4).map((t) => tagChip(t, { quiet: true })),
          freshnessBadge(hit.updatedAt, hit.verifiedAt))))));
}

// --- ナレッジの詳細 ---------------------------------------------------------------

async function renderKnowledge(id: string): Promise<void> {
  let k: Knowledge;
  try {
    k = await api<Knowledge>('GET', `/knowledge/${id}`);
  } catch (e) {
    return shell('search', h('section', { class: 'page' }, h('p', { class: 'error', role: 'alert' }, e instanceof Error ? e.message : String(e))));
  }
  const photos = photoSection(k.id, true);
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
  shell('search', h('article', { class: 'page knowledge' },
    h('button', { type: 'button', class: 'back', onclick: () => history.back() }, '戻る'),
    k.status !== 'published' ? h('p', { class: 'pending' }, '承認待ちです。承認されると全員に公開されます。') : null,
    k.pendingVersions.length > 0 && k.status === 'published' ? h('p', { class: 'pending' }, '修正案が承認を待っています。') : null,
    h('h1', {}, k.title),
    h('div', { class: 'tag-row' }, ...k.tags.map((t) => tagChip(t, { onClick: () => { location.hash = `#/search?q=${encodeURIComponent('#' + t)}`; } }))),
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
 * 詳細画面の新しさの表示：誰がいつ更新し、誰がいつ確認したか。
 * onVerify があれば「今も正しい」を出す。中身を変えずに確認日だけを新しくできる。
 */
function freshnessDetail(k: Knowledge, onVerify?: () => Promise<void>): HTMLElement {
  const f = freshness(k.updatedAt, k.verifiedAt);
  return h('div', { class: 'fresh-detail' },
    h('p', {}, `最終更新：${relativeDate(k.updatedAt)}${k.updatedBy ? `（${k.updatedBy}さん）` : ''}`),
    f.verified ? h('p', {}, `内容の確認：${relativeDate(k.verifiedAt)}${k.verifiedBy ? `（${k.verifiedBy}さん）` : ''}`) : null,
    f.stale ? h('p', { class: 'fresh-warn' }, `${staleLabel()}、更新も確認もされていません。今も正しいか社員に確かめてから案内してください。`) : null,
    // 古いものほど押してほしいので、古いときだけ目立たせる
    ...(onVerify ? [action(f.stale ? '今も正しい（確認日を更新）' : '今も正しい', f.stale ? 'primary' : 'secondary small', onVerify)] : []),
  );
}

// --- 書く（投稿・編集） ------------------------------------------------------------

async function loadAndEdit(id: string): Promise<void> {
  try {
    renderWrite(await api<Knowledge>('GET', `/knowledge/${id}`));
  } catch (e) {
    renderFatal(e);
  }
}

function renderWrite(existing: Knowledge | null): void {
  const tags: string[] = existing ? [...existing.tags] : [];
  const title = h('input', { id: 'title', type: 'text', maxlength: 100, value: existing?.title ?? '', placeholder: '例：冷蔵庫のリサイクル料金', required: true });
  const body = h('textarea', { id: 'body', rows: 8, placeholder: '手順や注意点。お客様への伝え方なども' });
  body.value = existing?.body ?? '';
  const tagField = h('input', { id: 'tag', type: 'text', placeholder: '#を付けずに入力してもOK', autocomplete: 'off', enterkeyhint: 'done' });
  const tagList = h('div', { class: 'tag-row' });
  const suggest = h('div', { class: 'suggest', hidden: true });
  const proposals = h('div', { class: 'proposals' });
  const message = h('p', { class: 'error', role: 'alert', hidden: true });

  const drawTags = () => {
    clear(tagList);
    tagList.append(...tags.map((t) => tagChip(t, { removable: true, onClick: () => { tags.splice(tags.indexOf(t), 1); drawTags(); drawProposals(); } })));
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
  title.addEventListener('input', drawProposals);
  body.addEventListener('input', drawProposals);

  const submit = async (e: Event) => {
    e.preventDefault();
    message.hidden = true;
    if (tagField.value.trim()) addTag(tagField.value);
    if (tags.length === 0) { message.textContent = 'ハッシュタグを1つ以上付けてください。'; message.hidden = false; tagField.focus(); return; }
    const payload = { title: title.value, body: body.value, tagNames: tags };
    try {
      type Saved = { id: string; published: boolean; readingsNeeded?: Array<{ id: string; name: string; proposed: string; candidates?: string[] }> };
      const r = existing
        ? await api<Saved>('PUT', `/knowledge/${existing.id}`, payload)
        : await api<Saved>('POST', `/stores/${storeId()}/knowledge`, payload);
      toast(r.published ? '公開しました' : '承認を依頼しました');
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
  shell('write', h('form', { class: 'page write', onsubmit: submit },
    h('h1', {}, existing ? 'ナレッジを編集' : 'ナレッジを書く'),
    h('label', { for: 'title' }, 'タイトル'), title,
    h('label', { for: 'body' }, '内容'), body,
    h('label', { for: 'tag' }, 'ハッシュタグ'),
    tagList, tagField, suggest, proposals,
    message,
    h('button', { type: 'submit', class: 'primary' }, isTrusted() ? '公開する' : '承認を依頼する'),
    isTrusted() ? null : h('p', { class: 'note' }, 'trusted のメンバーが承認すると公開されます。'),
  ));
  drawProposals();
  (existing ? body : title).focus();
}

// --- バーコード -------------------------------------------------------------------

function renderScan(initialJan: string): void {
  const field = h('input', { id: 'jan', type: 'text', inputmode: 'numeric', pattern: '[0-9]*', maxlength: 13, value: initialJan, placeholder: '4901234567894', autocomplete: 'off' });
  const out = h('div', { class: 'scan-result', 'aria-live': 'polite' });
  const video = h('video', { class: 'camera', playsinline: true, muted: true, hidden: true });
  const lookup = async () => {
    const jan = field.value.replace(/\D/g, '');
    if (!jan) return;
    history.replaceState(null, '', `#/scan?jan=${jan}`);
    try {
      renderScanResult(out, await api<ScanResult>('GET', `/stores/${storeId()}/barcode/${jan}`));
    } catch (e) {
      clear(out);
      out.append(h('p', { class: 'error', role: 'alert' }, e instanceof Error ? e.message : String(e)));
    }
  };
  // 端末が BarcodeDetector に対応していればカメラで読む（Android の Chrome など）。無ければ数字を入力する
  const Detector = (window as unknown as { BarcodeDetector?: new (o: { formats: string[] }) => { detect(v: HTMLVideoElement): Promise<Array<{ rawValue: string }>> } }).BarcodeDetector;
  const startCamera = async () => {
    if (!Detector) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      video.srcObject = stream;
      video.hidden = false;
      await video.play();
      const detector = new Detector({ formats: ['ean_13', 'ean_8'] });
      const tick = async () => {
        if (video.hidden) return;
        const codes = await detector.detect(video).catch(() => []);
        if (codes[0]) {
          field.value = codes[0].rawValue;
          stream.getTracks().forEach((t) => t.stop());
          video.hidden = true;
          void lookup();
          return;
        }
        requestAnimationFrame(() => void tick());
      };
      void tick();
    } catch {
      toast('カメラを使えませんでした。数字を入力してください');
    }
  };
  field.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); void lookup(); } });
  shell('search', h('section', { class: 'page' },
    h('h1', {}, 'バーコードで調べる'),
    Detector ? h('button', { type: 'button', class: 'primary', onclick: () => void startCamera() }, 'カメラで読み取る') : null,
    video,
    h('label', { for: 'jan' }, 'JANコード（バーコードの下の数字）'),
    h('div', { class: 'search-bar' }, field, h('button', { type: 'button', class: 'secondary', onclick: () => void lookup() }, '調べる')),
    out,
  ));
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
  const submit = async (e: Event) => {
    e.preventDefault();
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
  return h('form', { class: 'write', onsubmit: submit },
    h('label', { for: 'pname' }, '商品名'), name,
    h('label', { for: 'pmaker' }, 'メーカー'), maker,
    h('label', { for: 'pnote' }, '売場のメモ'), note,
    h('label', { for: 'ptag' }, 'ハッシュタグ'), tagList, tagField, suggest,
    message,
    h('button', { type: 'submit', class: 'primary' }, existing ? '保存する' : '登録する'));
}

// --- 承認・管理（trusted / administrator） --------------------------------------------

async function renderManage(): Promise<void> {
  if (!isTrusted()) { location.hash = '#/home'; return; }
  const section = h('section', { class: 'page manage' }, h('h1', {}, '承認・管理'));
  shell(null, section);
  try {
    const [pending, zero, stale] = await Promise.all([
      api<Array<{ id: string; version: number; title: string; edited_by: string; is_new: boolean }>>('GET', `/stores/${storeId()}/pending`),
      api<Array<{ query: string; times: number }>>('GET', `/stores/${storeId()}/zero-hits`),
      api<Array<{ id: string; title: string; verified_at: string | null }>>('GET', `/stores/${storeId()}/stale`),
    ]);
    section.append(
      ...countedList('承認待ち', pending, (p, remove) =>
        h('li', { class: 'row' },
          h('a', { href: `#/k/${p.id}` }, p.title),
          h('span', { class: 'hint' }, `${p.edited_by}さん・${p.is_new ? '新規' : '修正'}`),
          h('span', { class: 'row-actions' },
            action('公開する', 'primary small', async () => { await api('POST', `/knowledge/${p.id}/versions/${p.version}/approve`); toast('公開しました'); remove(); }),
            action('却下する', 'secondary small', async () => { await api('POST', `/knowledge/${p.id}/versions/${p.version}/reject`); toast('却下しました'); remove(); }))), 'h2'),
      h('h2', {}, '見つからなかった検索'),
      zero.length === 0 ? h('p', { class: 'hint' }, 'ありません。') : h('ul', { class: 'rows' }, ...zero.slice(0, 20).map((z) =>
        h('li', { class: 'row' }, h('span', {}, z.query), h('span', { class: 'hint' }, `${z.times}回`)))),
      ...countedList(`${staleLabel()}確認されていないナレッジ`, stale, (s, remove) =>
        h('li', { class: 'row' },
          h('a', { href: `#/k/${s.id}` }, s.title),
          h('span', { class: 'row-actions' },
            action('今も正しい', 'secondary small', async () => { await api('POST', `/knowledge/${s.id}/verify`); toast('確認済みにしました'); remove(); }))), 'h2'),
    );
    section.append(productPanel(storeId()), readingPanel(), tagPanel(isAdmin()), importPanel(storeId()));
    if (isAdmin()) section.append(staffPanel(storeId(), me!.id), inviteForm());
  } catch (e) {
    section.append(h('p', { class: 'error', role: 'alert' }, e instanceof Error ? e.message : String(e)));
  }
}

function inviteForm(): HTMLElement {
  const name = h('input', { id: 'iname', type: 'text', maxlength: 40, placeholder: '例：佐藤' });
  const trusted = h('input', { id: 'itrusted', type: 'checkbox' });
  const out = h('div', { class: 'invite-out', 'aria-live': 'polite' });
  const submit = async (e: Event) => {
    e.preventDefault();
    try {
      const r = await api<{ token: string; expiresAt: string }>('POST', '/invitations', {
        storeId: storeId(), name: name.value, trustLevel: trusted.checked ? 'trusted' : 'visitor',
      });
      const link = `${location.origin}${location.pathname}#invite=${encodeURIComponent(r.token)}`;
      const who = name.value;
      clear(out);
      const qr = h('div', { class: 'qr' });
      qr.innerHTML = qrToSvg(encodeQr(link), { label: `${who}さんの招待QRコード` });
      out.append(
        h('p', {}, `${who}さんのスマホでこのQRコードを読み取ってもらってください（1回限り・72時間有効）。`),
        qr,
        h('textarea', { rows: 3, readonly: true, class: 'invite-link' }, link),
        h('div', { class: 'actions' },
          h('button', { type: 'button', class: 'secondary', onclick: async () => { await navigator.clipboard.writeText(link).catch(() => {}); toast('コピーしました'); } }, 'リンクをコピー'),
          h('button', { type: 'button', class: 'secondary', onclick: () => printQr(who, qr.innerHTML) }, '印刷する')));
      name.value = '';
    } catch (err) {
      clear(out);
      out.append(h('p', { class: 'error', role: 'alert' }, err instanceof Error ? err.message : String(err)));
    }
  };
  return h('form', { class: 'write', onsubmit: submit },
    h('h2', {}, 'スタッフを招待する'),
    h('label', { for: 'iname' }, '名前'), name,
    h('label', { class: 'check' }, trusted, '最初から trusted にする（投稿がすぐ公開される）'),
    h('button', { type: 'submit', class: 'primary' }, '招待リンクを作る'),
    out);
}

/** 招待QRコードを1枚だけ別の窓で開いて印刷する（休憩室に貼る・手渡しする用） */
function printQr(who: string, svg: string): void {
  const w = window.open('', '_blank', 'width=480,height=640');
  if (!w) { toast('印刷用の画面を開けませんでした。ブラウザの設定を確かめてください。'); return; }
  w.document.write(
    `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>${who}さんの招待</title>`
    + '<style>body{font-family:system-ui,sans-serif;text-align:center;padding:24px}'
    + 'svg{width:min(80vw,320px);height:auto}p{font-size:14px;color:#333}</style></head><body>'
    + `<h1>${who}さん</h1>${svg}`
    + '<p>スマホのカメラで読み取ってください（1回限り・72時間有効）</p></body></html>',
  );
  w.document.close();
  w.focus();
  w.print();
}

void boot();
