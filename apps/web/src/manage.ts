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

interface ReadingProposal { id: string; name: string; proposed: string; useCount: number; candidates?: string[] }

/**
 * 読みを1つ尋ねる行。確認待ちの一覧と、保存した直後のその場での確認で、同じ形を使う。
 * 案は空のことがある（機械が自信を持てなかった語）。そのときは空欄で打ってもらう。
 */
export function readingRow(
  tag: { id: string; name: string; proposed: string; candidates?: string[] },
  onDone: () => void,
  extra?: Node | null,
): HTMLElement {
  // 読みは複数あってよい。「下取」は シタドリ とも シタトリ とも打たれる。
  // どちらが正しいかを決めずに両方入れておけば、どちらで打っても当たる。
  const fields = h('div', { class: 'reading-fields' });
  let last: HTMLInputElement | null = null;

  const addField = (value = '', focus = false): HTMLInputElement => {
    const input = h('input', {
      type: 'text', value, class: 'reading-field',
      placeholder: 'カタカナで入力',
      'aria-label': `#${tag.name} の読み`, autocomplete: 'off', spellcheck: 'false',
    });
    const remove = h('button', {
      type: 'button', class: 'reading-remove', 'aria-label': 'この読みを消す',
      onclick: () => { wrap.remove(); if (fields.children.length === 0) addField('', true); },
    }, '×');
    const wrap = h('div', { class: 'reading-line' }, input, remove);
    fields.append(wrap);
    if (focus) input.focus();
    last = input;
    return input;
  };

  addField(tag.proposed);

  /** 空いている欄に入れる。無ければ増やす。 */
  const fill = (value: string) => {
    const inputs = [...fields.querySelectorAll('input')] as HTMLInputElement[];
    const empty = inputs.find((i) => i.value.trim() === '');
    const target = empty ?? addField();
    target.value = value;
    target.focus();
  };

  // 候補は押すと欄に入るだけ。登録はしない。一文字違いならそこから直せる。
  const candidates = (tag.candidates ?? []).slice(0, 5);
  const chips = candidates.length === 0 ? null : h('div', { class: 'reading-candidates' },
    ...candidates.map((c) => h('button', {
      type: 'button', class: 'reading-chip', onclick: () => fill(c),
    }, c)));

  const save = async (readings: string[]) => {
    await api('POST', `/tag-readings/${tag.id}`, { readings });
    const kept = readings.map((r) => r.trim()).filter((r) => r !== '');
    toast(kept.length === 0 ? '読みなしで登録しました' : `#${tag.name} を「${kept.join('、')}」で登録しました`);
    onDone();
  };
  const values = () => ([...fields.querySelectorAll('input')] as HTMLInputElement[]).map((i) => i.value);

  return h('li', { class: 'row reading-row' },
    h('span', { class: 'reading-head' },
      h('span', { class: 'tag tag-inline' }, `#${tag.name}`),
      extra ?? null),
    fields,
    h('button', {
      type: 'button', class: 'reading-add',
      onclick: () => addField('', true),
    }, '＋ 読みを足す'),
    chips,
    h('span', { class: 'row-actions' },
      action('この読みで登録', 'primary small', () => save(values())),
      action('あとで', 'secondary small', () => { onDone(); return Promise.resolve(); })));
}

/**
 * 保存した直後に、新しく出来たタグの読みをその場で尋ねる。
 * 一番よく知っているのは、いま打った人なので、ここで聞くのが一番当たる。
 * 飛ばしても「承認・管理 → タグの読み」に残るので、取りこぼさない。
 */
export function askReadings(
  tags: Array<{ id: string; name: string; proposed: string; candidates?: string[] }>, onFinish: () => void,
): HTMLElement {
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
      + '（しょくせんき → #食洗機）。候補を押すと入力欄に入るので、'
      + '違っていたら直してください。あとでもかまいません。'),
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
        + '候補を押すと入力欄に入ります。違っていたら、そのまま直して登録してください。'),
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

interface StaffRow {
  id: string; name: string; trust_level: 'visitor' | 'trusted'; admin_scope: 'none' | 'store' | 'tenant';
  status: 'active' | 'disabled'; last_used_at: string | null; devices: number;
  /** 会社のアカウント（SSO）のメールアドレス。招待で入った人は無い */
  email: string | null;
  /** 会社のアカウントで入っているか。名前は相手の IdP が名乗ったもの */
  via_sso: boolean;
  /** この店に同じ名前の人が他にもいるか */
  same_name: boolean;
}

export function staffPanel(storeId: string, meId: string): HTMLElement {
  return panel('スタッフ', async (body) => {
    const users = await api<StaffRow[]>('GET', `/stores/${storeId}/users`);
    const list = h('ul', { class: 'rows' });
    const draw = (u: StaffRow, row: HTMLElement) => {
      clear(row);
      const role = u.admin_scope === 'tenant' ? '本部' : u.admin_scope === 'store' ? '店長' : u.trust_level === 'trusted' ? 'trusted' : 'visitor';
      // 同名の人がいるときは、名前だけでは見分けられないことを先に伝える。
      // 会社のアカウントで入った人の名前は相手の IdP が名乗ったものなので、
      // 既存の人に似せた名前で入ってくる余地がある。
      const marks: Node[] = [];
      if (u.same_name) marks.push(h('span', { class: 'warn-badge', title: 'この店に同じ名前の人がいます' }, '同名あり'));
      if (u.via_sso) marks.push(h('span', { class: 'pending' }, '会社アカウント'));
      row.append(
        h('span', {},
          h('strong', {}, u.name),
          u.status === 'disabled' ? h('span', { class: 'pending' }, '（無効）') : null,
          ...marks,
          u.email ? h('span', { class: 'staff-email' }, u.email) : null),
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

interface AccessRequestRow {
  id: string;
  email: string;
  claimedName: string | null;
  attempts: number;
  requestedAt: string;
  lastSeenAt: string;
  nameTaken: boolean;
}

/**
 * 会社のアカウントで入れたが、まだ登録されていない人の申請。
 *
 * ここに並ぶのは「その会社の人であることは確かだが、こちらに登録がない」人。
 * 名前は相手の IdP が名乗ったものなので、**そのまま使わずに直せる形**で出す。
 * 既存の人と同じ名前なら、その場で知らせる（似せた名前での紛れを防ぐため）。
 */
export function accessRequestPanel(
  stores: Array<{ id: string; name: string }>,
  currentStoreId: string,
  /** 決めたあとに数を取り直す（上の帯に出ている件数を合わせるため） */
  onDecided: () => void = () => {},
): HTMLElement {
  return panel('利用の申請', async (body) => {
    const rows = await api<AccessRequestRow[]>('GET', '/access-requests');
    body.append(...countedList('承認を待っている人', rows, (r, remove) => {
      const name = h('input', { type: 'text', value: r.claimedName ?? '', placeholder: '名前',
        'aria-label': `${r.email} の名前` });
      const store = h('select', { 'aria-label': `${r.email} の配属先` },
        ...stores.map((s) => h('option', { value: s.id, ...(s.id === currentStoreId ? { selected: true } : {}) }, s.name)));
      return h('li', { class: 'row request-row' },
        h('span', { class: 'request-who' },
          h('strong', {}, r.email),
          r.nameTaken
            ? h('span', { class: 'warn-badge' }, `「${r.claimedName}」は既にいます`)
            : null,
          h('span', { class: 'hint' },
            `${relativeDate(r.requestedAt)}に申請`
            + (r.attempts > 1 ? `・${r.attempts}回入ろうとしています` : ''))),
        h('span', { class: 'request-fields' },
          h('span', { class: 'field' }, h('span', { class: 'hint' }, '名前'), name),
          h('span', { class: 'field' }, h('span', { class: 'hint' }, '配属先'), store)),
        h('span', { class: 'row-actions' },
          action('承認する', 'primary small', async () => {
            const value = name.value.trim();
            if (value === '') { toast('名前を入れてください'); return; }
            await api('POST', `/access-requests/${r.id}/approve`, { storeId: store.value, name: value });
            toast(`${value}さんを登録しました`);
            remove();
            onDecided();
          }),
          confirmAction('断る', 'secondary small', `${r.email} の申請を断ります。`,
            async () => {
              await api('POST', `/access-requests/${r.id}/reject`);
              toast('断りました');
              remove();
              onDecided();
            })));
    }, 'h3'));
  });
}

interface ProviderRow {
  id: string;
  issuer: string;
  clientId: string;
  hasSecret: boolean;
  domains: string[];
  jitEnabled: boolean;
  defaultStoreId: string | null;
  defaultTrust: 'visitor' | 'trusted';
  disabled: boolean;
}

/**
 * 会社のアカウント（SSO）の設定。本部の管理者だけ。
 *
 * 相手の情報システム部から渡されるのは、発行元（issuer）・client_id・
 * 内緒の鍵の3つだけ。残りは相手が公開している設定から取るので、入力欄もこれだけにする。
 * 項目が増えるほど往復が増えて、導入が止まる。
 */
export function ssoPanel(stores: Array<{ id: string; name: string }>): HTMLElement {
  return panel('会社のアカウント（SSO）', async (body) => {
    const list = h('div');
    const problem = h('p', { class: 'error', role: 'alert', hidden: true });

    const refresh = async (): Promise<void> => {
      clear(list);
      const rows = await api<ProviderRow[]>('GET', '/sso/providers');
      list.append(...countedList('登録済み', rows.filter((r) => !r.disabled), (r, remove) =>
        h('li', { class: 'row' },
          h('span', {},
            h('strong', {}, r.domains.join('、') || '（ドメインなし）'),
            h('span', { class: 'staff-email' }, r.issuer),
            h('span', { class: 'hint' },
              `${r.hasSecret ? '内緒の鍵あり' : 'PKCE のみ'}・`
              + (r.jitEnabled ? '初回に自動で作る' : '初回は申請にする'))),
          h('span', { class: 'row-actions' },
            confirmAction('止める', 'secondary small',
              `${r.domains.join('、')} の人は、会社のアカウントで入れなくなります（登録済みの人は招待やパスキーで入れます）。`,
              async () => { await api('DELETE', `/sso/providers/${r.id}`); toast('止めました'); remove(); }))), 'h3'));
    };

    const issuer = h('input', { type: 'url', placeholder: 'https://login.microsoftonline.com/.../v2.0',
      'aria-label': '発行元（issuer）' });
    const clientId = h('input', { type: 'text', placeholder: 'client_id', 'aria-label': 'client_id' });
    const secret = h('input', { type: 'password', placeholder: '（PKCE だけで足りるなら空のまま）',
      autocomplete: 'off', 'aria-label': '内緒の鍵（client_secret）' });
    const domains = h('input', { type: 'text', placeholder: 'kdenki.example.co.jp',
      'aria-label': '会社のメールアドレスのドメイン' });
    const jit = h('input', { type: 'checkbox', id: 'sso-jit' });
    const store = h('select', { 'aria-label': '自動で作るときの配属先' },
      ...stores.map((s) => h('option', { value: s.id }, s.name)));

    const add = action('この設定で登録する', 'primary', async () => {
      problem.hidden = true;
      try {
        await api('POST', '/sso/providers', {
          issuer: issuer.value.trim(),
          clientId: clientId.value.trim(),
          clientSecret: secret.value.trim() || null,
          // 複数のドメインは、読点・カンマ・空白のどれで区切っても受ける
          domains: domains.value.split(/[、,\s]+/).map((d) => d.trim()).filter((d) => d !== ''),
          jitEnabled: jit.checked,
          ...(jit.checked ? { defaultStoreId: store.value } : {}),
        });
        toast('登録しました');
        issuer.value = ''; clientId.value = ''; secret.value = ''; domains.value = '';
        await refresh();
      } catch (e) {
        problem.textContent = e instanceof Error ? e.message : String(e);
        problem.hidden = false;
      }
    });

    body.append(
      h('p', { class: 'hint' },
        '相手の情報システム部から受け取るのは、発行元（issuer）と client_id、必要なら内緒の鍵だけです。'
        + '残りは相手が公開している設定から自動で読みます。'),
      list,
      h('h3', {}, '設定を足す'),
      h('div', { class: 'sso-form' },
        h('label', {}, '発行元（issuer）', issuer),
        h('label', {}, 'client_id', clientId),
        h('label', {}, '内緒の鍵（client_secret）', secret),
        h('label', {}, '会社のメールアドレスのドメイン', domains),
        h('p', { class: 'hint' }, 'このドメインのアドレスを打った人を、この設定に通します。複数なら読点で区切ってください。'),
        h('label', { class: 'sso-jit', for: 'sso-jit' }, jit,
          h('span', {}, '初めて入ってきた人を、申請を挟まず自動で登録する'),
        ),
        h('p', { class: 'hint' },
          '入れないままが既定です。既定では申請になり、「利用の申請」で名前と配属先を決めて承認します。'
          + '自動で作る場合は、下の店舗に配属され、権限は visitor（投稿は承認を通る）になります。'),
        h('label', {}, '自動で作るときの配属先', store),
      ),
      add,
      problem,
    );
    await refresh();
  });
}
