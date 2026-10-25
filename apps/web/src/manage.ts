// 承認・管理の画面の部品：タグ辞書、商品の承認待ち、スタッフ。

import { api } from './api.ts';
import { clear, h, relativeDate, tagChip, toast } from './dom.ts';

/** ボタンの処理を実行し、失敗したらその理由を知らせる。実行中はボタンを押せなくする */
export function action(label: string, cls: string, fn: () => Promise<void>): HTMLButtonElement {
  const btn = h('button', { type: 'button', class: cls }, label);
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    try {
      await fn();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    } finally {
      btn.disabled = false;
    }
  });
  return btn;
}

/** 開閉できるまとまり。中身は開いたときに読み込む */
export function panel(title: string, load: (body: HTMLElement) => Promise<void>): HTMLElement {
  const body = h('div', { class: 'panel-body' });
  const el = h('details', { class: 'panel' }, h('summary', {}, title), body);
  let loaded = false;
  el.addEventListener('toggle', async () => {
    if (!el.open || loaded) return;
    loaded = true;
    body.append(h('p', { class: 'hint' }, '読み込んでいます…'));
    try {
      clear(body);
      await load(body);
    } catch (e) {
      clear(body);
      body.append(h('p', { class: 'error', role: 'alert' }, e instanceof Error ? e.message : String(e)));
      loaded = false;
    }
  });
  return el;
}

// --- タグ辞書 -------------------------------------------------------------------------

interface Relation { id: string; kind: 'synonym' | 'includes' | 'alias'; from_tag: string | null; from_text: string | null; to_tag: string; source: string; evidence: number }

const KIND_LABEL: Record<Relation['kind'], string> = { synonym: '同じ意味', includes: 'の中に含む', alias: 'と言われたら' };
const SOURCE_LABEL: Record<string, string> = { picked_log: '「もしかして」でよく選ばれた', manual: '提案', dictionary: '辞書', vector: '意味が近い' };

function relationText(r: Relation): HTMLElement {
  const from = r.kind === 'alias' ? h('span', { class: 'quote' }, `「${r.from_text}」`) : tagChip(r.from_tag ?? '', { quiet: true });
  return h('span', { class: 'relation' }, from, h('span', { class: 'hint' }, KIND_LABEL[r.kind]), tagChip(r.to_tag, { quiet: true }));
}

export function tagPanel(isAdmin: boolean): HTMLElement {
  return panel('タグ辞書', async (body) => {
    const candidates = await api<Relation[]>('GET', '/tag-relations?state=candidate');
    const approved = await api<Relation[]>('GET', '/tag-relations?state=approved');
    body.append(
      h('h3', {}, `承認待ちの関係（${candidates.length}件）`),
      candidates.length === 0 ? h('p', { class: 'hint' }, 'ありません。') : h('ul', { class: 'rows' }, ...candidates.map((r) => {
        const row = h('li', { class: 'row' },
          relationText(r),
          h('span', { class: 'hint' }, `${SOURCE_LABEL[r.source] ?? r.source}・${r.evidence}回`),
          h('span', { class: 'row-actions' },
            action('承認する', 'primary small', async () => { await api('POST', `/tag-relations/${r.id}/approve`); toast('承認しました'); row.remove(); }),
            action('却下する', 'secondary small', async () => { await api('POST', `/tag-relations/${r.id}/reject`); toast('却下しました'); row.remove(); })));
        return row;
      })),
      relationForm(),
      h('h3', {}, `登録済みの関係（${approved.length}件）`),
      approved.length === 0 ? h('p', { class: 'hint' }, 'ありません。') : h('ul', { class: 'rows' }, ...approved.map((r) => {
        const row = h('li', { class: 'row' }, relationText(r),
          h('span', { class: 'row-actions' },
            action('外す', 'secondary small', async () => { await api('DELETE', `/tag-relations/${r.id}`); toast('外しました'); row.remove(); })));
        return row;
      })),
      ...(isAdmin ? [mergeForm()] : []),
    );
  });
}

function relationForm(): HTMLElement {
  const kind = h('select', { id: 'rkind', 'aria-label': '関係の種類' },
    h('option', { value: 'synonym' }, '同じ意味（どちらで検索しても両方出る）'),
    h('option', { value: 'includes' }, '含む（上位で検索すると下位も出る）'),
    h('option', { value: 'alias' }, '言い換え（この言葉をタグとして扱う）'));
  const from = h('input', { id: 'rfrom', type: 'text', placeholder: '例：エアコン', autocomplete: 'off' });
  const to = h('input', { id: 'rto', type: 'text', placeholder: '例：クーラー', autocomplete: 'off' });
  const fromLabel = h('label', { for: 'rfrom' }, '元のタグ');
  kind.addEventListener('change', () => {
    fromLabel.textContent = kind.value === 'alias' ? '言い換えの言葉' : kind.value === 'includes' ? '上位のタグ（含む側）' : '元のタグ';
    from.placeholder = kind.value === 'alias' ? '例：映らない' : kind.value === 'includes' ? '例：冷蔵庫' : '例：エアコン';
    to.placeholder = kind.value === 'alias' ? '例：修理' : kind.value === 'includes' ? '例：冷凍冷蔵庫' : '例：クーラー';
  });
  const submit = async (e: Event) => {
    e.preventDefault();
    try {
      const body = kind.value === 'alias'
        ? { kind: 'alias', fromText: from.value, toTag: to.value }
        : { kind: kind.value, fromTag: from.value, toTag: to.value };
      const r = await api<{ state: string }>('POST', '/tag-relations', body);
      toast(r.state === 'approved' ? '登録しました' : '承認を依頼しました');
      from.value = '';
      to.value = '';
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err));
    }
  };
  return h('form', { class: 'write', onsubmit: submit },
    h('h3', {}, '関係を追加する'),
    h('label', { for: 'rkind' }, '種類'), kind,
    fromLabel, from,
    h('label', { for: 'rto' }, 'タグ'), to,
    h('button', { type: 'submit', class: 'primary' }, '追加する'));
}

function mergeForm(): HTMLElement {
  const from = h('input', { id: 'mfrom', type: 'text', placeholder: '例：長期保障', autocomplete: 'off' });
  const into = h('input', { id: 'minto', type: 'text', placeholder: '例：長期保証', autocomplete: 'off' });
  const submit = async (e: Event) => {
    e.preventDefault();
    if (!window.confirm(`#${from.value.replace(/^#/, '')} を #${into.value.replace(/^#/, '')} に統合します。統合元のタグは使えなくなり、別名として残ります。`)) return;
    try {
      const r = await api<{ reindexed: number }>('POST', '/tags/merge', { from: from.value, into: into.value });
      toast(`統合しました（${r.reindexed}件のナレッジを付け替え）`);
      from.value = '';
      into.value = '';
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err));
    }
  };
  return h('form', { class: 'write', onsubmit: submit },
    h('h3', {}, '表記ゆれのタグを統合する'),
    h('p', { class: 'hint' }, '全店舗の検索に効きます。統合元の名前で検索・投稿しても、統合先として扱われます。'),
    h('label', { for: 'mfrom' }, '統合元（なくすタグ）'), from,
    h('label', { for: 'minto' }, '統合先（残すタグ）'), into,
    h('button', { type: 'submit', class: 'primary' }, '統合する'));
}

// --- 商品の承認待ち ----------------------------------------------------------------------

interface PendingProducts {
  products: Array<{ id: string; jan_code: string; name: string; created_at: string; created_by: string }>;
  changes: Array<{ id: string; product_id: string; name: string; payload: Record<string, unknown>; requested_at: string; requested_by: string }>;
}

const FIELD_LABEL: Record<string, string> = { name: '商品名', maker: 'メーカー', areaId: '売場', note: '売場のメモ', tagNames: 'タグ' };

export function productPanel(storeId: string): HTMLElement {
  return panel('商品の承認待ち', async (body) => {
    const p = await api<PendingProducts>('GET', `/stores/${storeId}/pending-products`);
    body.append(
      h('h3', {}, `登録（${p.products.length}件）`),
      p.products.length === 0 ? h('p', { class: 'hint' }, 'ありません。') : h('ul', { class: 'rows' }, ...p.products.map((x) => {
        const row = h('li', { class: 'row' },
          h('a', { href: `#/scan?jan=${x.jan_code}` }, x.name),
          h('span', { class: 'hint' }, `${x.created_by}さん・${relativeDate(x.created_at)}`),
          h('span', { class: 'row-actions' },
            action('承認する', 'primary small', async () => { await api('POST', `/products/${x.id}/approve`); toast('承認しました'); row.remove(); })));
        return row;
      })),
      h('h3', {}, `修正（${p.changes.length}件）`),
      p.changes.length === 0 ? h('p', { class: 'hint' }, 'ありません。') : h('ul', { class: 'rows' }, ...p.changes.map((c) => {
        const fields = Object.keys(c.payload).map((k) => FIELD_LABEL[k] ?? k).join('、');
        const row = h('li', { class: 'row' },
          h('span', {}, h('strong', {}, c.name), `（${fields}）`),
          h('span', { class: 'hint' }, `${c.requested_by}さん・${relativeDate(c.requested_at)}`),
          h('span', { class: 'row-actions' },
            action('反映する', 'primary small', async () => { await api('POST', `/product-changes/${c.id}/approve`); toast('反映しました'); row.remove(); }),
            action('却下する', 'secondary small', async () => { await api('POST', `/product-changes/${c.id}/reject`); toast('却下しました'); row.remove(); })));
        return row;
      })),
    );
  });
}

// --- スタッフ -------------------------------------------------------------------------

interface StaffRow { id: string; name: string; trust_level: 'visitor' | 'trusted'; admin_scope: 'none' | 'store' | 'tenant'; status: 'active' | 'disabled'; last_used_at: string | null; devices: number }

export function staffPanel(storeId: string, meId: string): HTMLElement {
  return panel('スタッフ', async (body) => {
    const users = await api<StaffRow[]>('GET', `/stores/${storeId}/users`);
    const list = h('ul', { class: 'rows' });
    const draw = (u: StaffRow, row: HTMLElement) => {
      clear(row);
      const role = u.admin_scope === 'tenant' ? '本部' : u.admin_scope === 'store' ? '店長' : u.trust_level === 'trusted' ? 'trusted' : 'visitor';
      row.append(
        h('span', {}, h('strong', {}, u.name), u.status === 'disabled' ? h('span', { class: 'pending' }, '（無効）') : null),
        h('span', { class: 'hint' }, `${role}・端末${u.devices}台・${u.last_used_at ? `${relativeDate(u.last_used_at)}に利用` : '未利用'}`),
        u.id === meId || u.admin_scope !== 'none' ? h('span', {}) : h('span', { class: 'row-actions' },
          u.status === 'active'
            ? action(u.trust_level === 'trusted' ? 'visitor に戻す' : 'trusted にする', 'secondary small', async () => {
                const next = u.trust_level === 'trusted' ? 'visitor' : 'trusted';
                await api('PATCH', `/users/${u.id}`, { trustLevel: next });
                u.trust_level = next;
                toast(next === 'trusted' ? 'trusted にしました' : 'visitor に戻しました');
                draw(u, row);
              })
            : null,
          action(u.status === 'active' ? '無効にする' : '有効に戻す', 'secondary small', async () => {
            const next = u.status === 'active' ? 'disabled' : 'active';
            if (next === 'disabled' && !window.confirm(`${u.name}さんを無効にすると、その人のすべての端末からすぐに使えなくなります。`)) return;
            await api('PATCH', `/users/${u.id}`, { status: next });
            u.status = next;
            if (next === 'disabled') u.devices = 0;
            toast(next === 'disabled' ? '無効にしました' : '有効に戻しました');
            draw(u, row);
          })),
      );
    };
    for (const u of users) {
      const row = h('li', { class: 'row' });
      draw(u, row);
      list.append(row);
    }
    body.append(users.length === 0 ? h('p', { class: 'hint' }, 'まだいません。') : list);
  });
}
