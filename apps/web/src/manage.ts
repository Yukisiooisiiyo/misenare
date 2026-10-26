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

/**
 * 取り消せない操作の確認。その場で「本当に？」を出す。
 * window.confirm は、埋め込みで開いたときに黙って false になる環境があるので使わない。
 */
export function confirmAction(
  label: string, cls: string, question: string, fn: () => Promise<void>, ariaLabel?: string,
): HTMLElement {
  const wrap = h('span', { class: 'confirm' });
  const draw = (asking: boolean): void => {
    clear(wrap);
    if (!asking) {
      wrap.append(h('button', {
        type: 'button', class: cls, 'aria-label': ariaLabel ?? label, onclick: () => draw(true),
      }, label));
      return;
    }
    wrap.append(
      h('span', { class: 'confirm-q' }, question),
      action('はい', 'primary small', fn),
      h('button', { type: 'button', class: 'secondary small', onclick: () => draw(false) }, 'やめる'),
    );
  };
  draw(false);
  return wrap;
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

/**
 * 見出しと一覧。行を片付けると件数が減り、なくなれば「ありません。」に変わる。
 * render には、その行を片付けるための remove を渡す。
 */
export function countedList<T>(title: string, items: T[], render: (item: T, remove: () => void) => HTMLElement, level: 'h2' | 'h3' = 'h3'): HTMLElement[] {
  const heading = h(level, {});
  const list = h('ul', { class: 'rows' });
  const empty = h('p', { class: 'hint' }, 'ありません。');
  let left = items.length;
  const draw = () => {
    heading.textContent = `${title}（${left}件）`;
    list.hidden = left === 0;
    empty.hidden = left > 0;
  };
  for (const item of items) {
    const row = render(item, () => { row.remove(); left -= 1; draw(); });
    list.append(row);
  }
  draw();
  return [heading, list, empty];
}

// --- タグ辞書 -------------------------------------------------------------------------

interface Relation { id: string; kind: 'synonym' | 'includes' | 'alias'; from_tag: string | null; from_text: string | null; to_tag: string; source: string; evidence: number }

const KIND_LABEL: Record<Relation['kind'], string> = { synonym: '同じ意味', includes: 'の中に含む', alias: 'と言われたら' };
const SOURCE_LABEL: Record<string, string> = { picked_log: '「もしかして」でよく選ばれた', manual: '提案', dictionary: '辞書', vector: '意味が近い' };

function relationText(r: Relation): HTMLElement {
  const from = r.kind === 'alias' ? h('span', { class: 'quote' }, `「${r.from_text}」`) : tagChip(r.from_tag ?? '', { quiet: true });
  return h('span', { class: 'relation' }, from, h('span', { class: 'hint' }, KIND_LABEL[r.kind]), tagChip(r.to_tag, { quiet: true }));
}

interface ReadingProposal { id: string; name: string; proposed: string; useCount: number }

/**
 * 読みを1つ尋ねる行。確認待ちの一覧と、保存した直後のその場での確認で、同じ形を使う。
 * 案は空のことがある（機械が自信を持てなかった語）。そのときは空欄で打ってもらう。
 */
export function readingRow(
  tag: { id: string; name: string; proposed: string },
  onDone: () => void,
  extra?: Node | null,
): HTMLElement {
  const field = h('input', {
    type: 'text', value: tag.proposed, class: 'reading-field',
    placeholder: tag.proposed === '' ? 'カタカナで入力' : '',
    'aria-label': `#${tag.name} の読み`, autocomplete: 'off', spellcheck: 'false',
  });
  const save = async (reading: string | null) => {
    await api('POST', `/tag-readings/${tag.id}`, { reading });
    toast(reading === null ? '読みなしで登録しました' : `#${tag.name} を「${reading}」で登録しました`);
    onDone();
  };
  return h('li', { class: 'row reading-row' },
    h('span', { class: 'reading-head' },
      h('span', { class: 'tag tag-inline' }, `#${tag.name}`),
      extra ?? null,
      tag.proposed === '' ? h('span', { class: 'hint' }, '案なし') : null),
    field,
    h('span', { class: 'row-actions' },
      action('この読みで登録', 'primary small', () => save(field.value)),
      action('あとで', 'secondary small', () => { onDone(); return Promise.resolve(); })));
}

/**
 * 保存した直後に、新しく出来たタグの読みをその場で尋ねる。
 * 一番よく知っているのは、いま打った人なので、ここで聞くのが一番当たる。
 * 飛ばしても「承認・管理 → タグの読み」に残るので、取りこぼさない。
 */
export function askReadings(tags: Array<{ id: string; name: string; proposed: string }>, onFinish: () => void): HTMLElement {
  const remaining = new Set(tags.map((t) => t.id));
  const list = h('ul', { class: 'rows' });
  const done = (id: string) => {
    remaining.delete(id);
    if (remaining.size === 0) onFinish();
  };
  for (const t of tags) {
    const row = readingRow(t, () => { row.remove(); done(t.id); });
    list.append(row);
  }
  return h('section', { class: 'page reading-ask' },
    h('h1', {}, '読みを教えてください'),
    h('p', { class: 'hint' },
      '新しいタグができました。読みを登録すると、かなでも引けるようになります'
      + '（しょくせんき → #食洗機）。あとで登録してもかまいません。'),
    list,
    h('button', { type: 'button', class: 'secondary', onclick: onFinish }, 'まとめてあとにする'));
}

/**
 * タグの読みの確認。
 *
 * 機械が出した読みは外すことがあるので、そのままでは検索に効かせない。
 * ここで**書き換えられる形で**見せて、人が決めたものだけを登録する。
 * 「この読みで登録しますか」を、読みを直せる入力欄と一緒に出すのが肝。
 */
export function readingPanel(): HTMLElement {
  return panel('タグの読み（確認待ち）', async (body) => {
    const rows = await api<ReadingProposal[]>('GET', '/tag-readings');
    if (rows.length === 0) {
      body.append(h('p', { class: 'hint' }, '確かめる読みはありません。'));
      return;
    }
    body.append(
      h('p', { class: 'hint' },
        '読みを登録すると、かなでも引けるようになります（れいぞうこ → #冷蔵庫）。'
        + '案が入っているものは機械が出したものなので、違っていたら直してください。'
        + '空いているものは、機械が自信を持てなかった語です。'),
      ...countedList('確認待ち', rows, (r, remove) =>
        readingRow(r, remove, h('span', { class: 'hint' }, `${r.useCount}件`))),
    );
  });
}

export function tagPanel(isAdmin: boolean): HTMLElement {
  return panel('タグ辞書', async (body) => {
    const candidates = await api<Relation[]>('GET', '/tag-relations?state=candidate');
    const approved = await api<Relation[]>('GET', '/tag-relations?state=approved');
    body.append(
      ...countedList('承認待ちの関係', candidates, (r, remove) =>
        h('li', { class: 'row' },
          relationText(r),
          h('span', { class: 'hint' }, `${SOURCE_LABEL[r.source] ?? r.source}・${r.evidence}回`),
          h('span', { class: 'row-actions' },
            action('承認する', 'primary small', async () => { await api('POST', `/tag-relations/${r.id}/approve`); toast('承認しました'); remove(); }),
            action('却下する', 'secondary small', async () => { await api('POST', `/tag-relations/${r.id}/reject`); toast('却下しました'); remove(); })))),
      relationForm(),
      ...countedList('登録済みの関係', approved, (r, remove) =>
        h('li', { class: 'row' }, relationText(r),
          h('span', { class: 'row-actions' },
            action('外す', 'secondary small', async () => { await api('DELETE', `/tag-relations/${r.id}`); toast('外しました'); remove(); })))),
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
    h('p', { class: 'hint' }, '統合元のタグは使えなくなり、別名として残ります。'),
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
      ...countedList('登録', p.products, (x, remove) =>
        h('li', { class: 'row' },
          h('a', { href: `#/scan?jan=${x.jan_code}` }, x.name),
          h('span', { class: 'hint' }, `${x.created_by}さん・${relativeDate(x.created_at)}`),
          h('span', { class: 'row-actions' },
            action('承認する', 'primary small', async () => { await api('POST', `/products/${x.id}/approve`); toast('承認しました'); remove(); })))),
      ...countedList('修正', p.changes, (c, remove) =>
        h('li', { class: 'row' },
          h('span', {}, h('strong', {}, c.name), `（${Object.keys(c.payload).map((k) => FIELD_LABEL[k] ?? k).join('、')}）`),
          h('span', { class: 'hint' }, `${c.requested_by}さん・${relativeDate(c.requested_at)}`),
          h('span', { class: 'row-actions' },
            action('反映する', 'primary small', async () => { await api('POST', `/product-changes/${c.id}/approve`); toast('反映しました'); remove(); }),
            action('却下する', 'secondary small', async () => { await api('POST', `/product-changes/${c.id}/reject`); toast('却下しました'); remove(); })))),
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
          u.status === 'active'
            ? confirmAction('無効にする', 'secondary small', `${u.name}さんの端末がすぐ使えなくなります。`, async () => {
                await api('PATCH', `/users/${u.id}`, { status: 'disabled' });
                u.status = 'disabled';
                u.devices = 0;
                toast('無効にしました');
                draw(u, row);
              })
            : action('有効に戻す', 'secondary small', async () => {
                await api('PATCH', `/users/${u.id}`, { status: 'active' });
                u.status = 'active';
                toast('有効に戻しました');
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

// --- 既存マニュアルの取り込み -------------------------------------------------------

interface ImportRow { id: string; file_name: string; drafts: number; pending: number; created_at: string; created_by: string }
interface ImportResult { importId: string; fileName: string; drafts: number; warnings: string[]; preview: Array<{ id: string; title: string; source: string | null }> }

export function importPanel(storeId: string): HTMLElement {
  return panel('マニュアルの取り込み', async (body) => {
    const file = h('input', { type: 'file', id: 'import-file', accept: '.txt,.md,.csv,.tsv,.docx,.xlsx,.pdf', hidden: true });
    const button = h('button', { type: 'button', class: 'primary' }, 'ファイルを選ぶ');
    const status = h('p', { class: 'hint', hidden: true });
    const result = h('div', { 'aria-live': 'polite' });
    const list = h('div');

    const drawList = async () => {
      clear(list);
      const rows = await api<ImportRow[]>('GET', `/stores/${storeId}/imports`);
      list.append(...countedList('取り込んだ資料', rows, (r, remove) =>
        h('li', { class: 'row' },
          h('span', {}, h('strong', {}, r.file_name), `（${r.drafts}件）`),
          h('span', { class: 'hint' }, `${r.created_by}さん・${relativeDate(r.created_at)}・残り${r.pending}件`),
          r.pending === 0 ? h('span', {}) : h('span', { class: 'row-actions' },
            confirmAction('残りを取り下げる', 'secondary small', `まだ承認していない${r.pending}件を取り下げます。`, async () => {
              const out = await api<{ discarded: number }>('POST', `/imports/${r.id}/discard`);
              toast(`${out.discarded}件を取り下げました`);
              remove();
            })))));
    };

    button.addEventListener('click', () => file.click());
    file.addEventListener('change', async () => {
      const chosen = file.files?.[0];
      file.value = '';
      if (!chosen) return;
      button.disabled = true;
      status.textContent = `${chosen.name} を読んでいます…`;
      status.hidden = false;
      clear(result);
      try {
        const out = await api<ImportResult>('POST', `/stores/${storeId}/imports?name=${encodeURIComponent(chosen.name)}`, await chosen.arrayBuffer());
        result.append(
          h('p', {}, `${out.drafts}件の下書きを作りました。「承認待ち」から1件ずつ確かめて公開してください。`),
          ...(out.warnings ?? []).map((w) => h('p', { class: 'pending' }, w)),
          h('ul', { class: 'rows' }, ...out.preview.map((p) =>
            h('li', { class: 'row' }, h('a', { href: `#/k/${p.id}` }, p.title), p.source ? h('span', { class: 'hint' }, p.source) : null))),
        );
        await drawList();
      } catch (e) {
        result.append(h('p', { class: 'error', role: 'alert' }, e instanceof Error ? e.message : String(e)));
      } finally {
        button.disabled = false;
        status.hidden = true;
      }
    });

    body.append(
      h('p', { class: 'hint' }, '手順書や FAQ から下書きをまとめて作ります。読めるのは .txt .md .csv .tsv .docx .xlsx .pdf です。'),
      h('p', { class: 'hint' }, 'Word と PDF は見出し、Excel と CSV は1行ごとに区切ります。タグは付かないので、承認するときに付けてください。'),
      h('p', { class: 'hint' }, 'PDF は文字が入っているものだけ読めます（写真を貼っただけのものは読めません）。'),
      button, file, status, result,
    );
    await drawList();
  });
}
