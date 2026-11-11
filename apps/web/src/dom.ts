// 小さな DOM ヘルパー。ライブラリは使わない。

type Child = Node | string | null | undefined | false;
type Attrs = Record<string, string | number | boolean | EventListener | null | undefined>;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v as EventListener);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

export function clear(el: Element): void {
  while (el.firstChild) el.firstChild.remove();
}

/** 確認日の表示（「3日前に確認」「未確認」） */
export function verifiedLabel(iso: string | null): string {
  return iso ? `${relativeDate(iso)}に確認` : '未確認';
}

/**
 * 更新・確認のうち新しい方から、この日数を過ぎたら「古い可能性」として知らせる。
 * 本当の値はサーバーが決め（apps/api/src/domain/knowledge.ts の STALE_DAYS）、
 * /me で受け取って setStaleDays で入れ替える。ここの値は受け取る前の控え。
 */
let staleDays = 180;

export function setStaleDays(days: number): void {
  if (Number.isFinite(days) && days > 0) staleDays = days;
}

export function getStaleDays(): number { return staleDays; }

export function parseDate(iso: string | null): Date | null {
  if (!iso) return null;
  const d = new Date(iso.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00'));
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * 情報の新しさの表示。最終更新日を主に出し、内容を変えずに確認した日の方が新しいときだけ添える。
 * どちらも STALE_DAYS より前なら stale にする。
 */
export function freshness(updatedAt: string | null, verifiedAt: string | null): { updated: string; verified: string | null; stale: boolean } {
  const u = parseDate(updatedAt);
  const v = parseDate(verifiedAt);
  const latest = Math.max(u?.getTime() ?? 0, v?.getTime() ?? 0);
  const stale = latest === 0 || Date.now() - latest > staleDays * 86_400_000;
  const verifiedLater = u !== null && v !== null && v.getTime() - u.getTime() > 86_400_000;
  return {
    updated: u ? `${relativeDate(updatedAt)}に更新` : '更新日不明',
    verified: verifiedLater ? `${relativeDate(verifiedAt)}に確認` : null,
    stale,
  };
}

/** 検索結果などに添える、最終更新日の表示 */
export function freshnessBadge(updatedAt: string | null, verifiedAt: string | null): HTMLElement {
  const f = freshness(updatedAt, verifiedAt);
  return h('span', { class: `fresh${f.stale ? ' fresh-stale' : ''}` },
    h('span', {}, f.updated),
    f.verified ? h('span', { class: 'fresh-verified' }, f.verified) : null,
    f.stale ? h('span', { class: 'fresh-warn' }, '古い可能性があります') : null);
}

/** 日時を「今日 14:05」「3日前」「2026年4月2日」のように短く表す */
export function relativeDate(iso: string | null): string {
  if (!iso) return '未確認';
  // PostgreSQL の text 表現（"2026-10-25 16:05:01.12+00"）も ISO 8601 に寄せて読む
  const d = parseDate(iso);
  if (!d) return '未確認';
  const days = Math.floor((Date.now() - d.getTime()) / 86_400_000);
  if (days < 1) return `今日 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (days < 30) return `${days}日前`;
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

/** ハッシュタグのチップ（棚札の POP） */
export function tagChip(name: string, opts: { onClick?: () => void; removable?: boolean; quiet?: boolean } = {}): HTMLElement {
  const label = `#${name}`;
  const cls = `tag${opts.quiet ? ' tag-quiet' : ''}`;
  if (opts.onClick) {
    return h('button', { type: 'button', class: cls, onclick: () => opts.onClick!(), 'aria-label': opts.removable ? `${label} を外す` : label },
      label, opts.removable ? h('span', { class: 'tag-x', 'aria-hidden': 'true' }, '×') : null);
  }
  return h('span', { class: cls }, label);
}

type Control = HTMLButtonElement | HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;

/**
 * 処理中は同じ処理を二重に走らせない。
 * 売場の電波は遅いので、応答を待つ間に押し直されやすい。投稿は連打すると同じ内容が2件公開されるため、
 * 走っている間は呼ばれても無視し、controls で渡した部品を押せなくする（元から無効だったものは触らない）。
 */
export function busyGuard(controls: () => Control[], fn: () => Promise<void>): () => Promise<void> {
  let busy = false;
  return async () => {
    if (busy) return;
    busy = true;
    const targets = controls().filter((c) => !c.disabled);
    for (const c of targets) c.disabled = true;
    try {
      await fn();
    } finally {
      for (const c of targets) c.disabled = false;
      busy = false;
    }
  };
}

/**
 * フォームの送信を1回ずつにする。送信中は送信ボタンと入力欄を無効にし、終わったら戻す。
 * 無効にした欄の値は読めるので、handler の中で今までどおり .value を使ってよい。
 * preventDefault もここで行う（handler では要らない）。
 */
export function submitOnce(form: HTMLFormElement, handler: () => Promise<void>): void {
  const run = busyGuard(
    () => [...form.querySelectorAll<Control>('button[type="submit"], input, textarea, select')],
    handler);
  form.addEventListener('submit', (e) => { e.preventDefault(); void run(); });
}

export function toast(message: string): void {
  const el = h('div', { class: 'toast', role: 'status' }, message);
  document.body.append(el);
  setTimeout(() => el.remove(), 2600);
}
