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

/** 日時を「今日 14:05」「3日前」「2026年4月2日」のように短く表す */
export function relativeDate(iso: string | null): string {
  if (!iso) return '未確認';
  // PostgreSQL の text 表現（"2026-10-25 16:05:01.12+00"）も ISO 8601 に寄せて読む
  const d = new Date(iso.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00'));
  if (Number.isNaN(d.getTime())) return '未確認';
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

export function toast(message: string): void {
  const el = h('div', { class: 'toast', role: 'status' }, message);
  document.body.append(el);
  setTimeout(() => el.remove(), 2600);
}
