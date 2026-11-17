// 商品と売場の、あとから足した部品。
//
//   productFinder … 登録済みの商品を名前から探す（バーコードが読めない・手元に無いとき）
//   productExtras … 商品を直す画面の下に置くもの（結ぶナレッジ・変更の履歴・消す）
//   areaPanel     … 売場の名前を作る・変える・消す（店長・本部）
//   areaPicker    … ナレッジに、どの売場の話かを付ける
//
// 消す・外すは、直す画面の中にだけ置く（読んでいるだけのときに、誤って押さないように）。

import { api, type Hit, type ProductCard, type SearchResult } from './api.ts';
import { clear, h, relativeDate, submitOnce, toast } from './dom.ts';
import { action, confirmAction, panel } from './manage.ts';

export interface Area { id: string; name: string; products: number }

/** その店舗の売場の一覧。取れなければ空として扱う（売場は付けなくても困らない） */
export async function loadAreas(storeId: string): Promise<Area[]> {
  try {
    return await api<Area[]>('GET', `/stores/${storeId}/areas`);
  } catch {
    return [];
  }
}

interface ProductListItem { id: string; janCode: string; name: string; maker: string | null; area: string | null }

/** 登録済みの商品を、名前から探す。押すと、その商品の画面（バーコードを読んだときと同じ）へ行く */
export function productFinder(storeId: string): HTMLElement {
  const field = h('input', { type: 'search', maxlength: 100, placeholder: '商品名・メーカー・JANの頭', 'aria-label': '商品を探す言葉', autocomplete: 'off', enterkeyhint: 'search' });
  const list = h('ul', { class: 'rows' });
  const note = h('p', { class: 'hint' });
  const more = h('button', { type: 'button', class: 'secondary small', hidden: true }, 'もっと見る');
  let seq = 0;
  let next: number | null = null;
  const row = (p: ProductListItem): HTMLElement => h('li', { class: 'row' },
    h('a', { href: `#/scan?jan=${p.janCode}` }, p.name),
    h('span', { class: 'hint' }, [p.maker, p.area ? `売場：${p.area}` : null, `JAN ${p.janCode}`].filter(Boolean).join('　')));
  const load = async (offset: number): Promise<void> => {
    const mine = ++seq;
    if (offset === 0) note.textContent = '読み込んでいます…';
    try {
      const r = await api<{ items: ProductListItem[]; next: number | null }>('GET', `/stores/${storeId}/products?q=${encodeURIComponent(field.value.trim())}&offset=${offset}`);
      if (mine !== seq) return; // 打ち直したあとに届いた、前の言葉の結果は捨てる
      if (offset === 0) clear(list);
      list.append(...r.items.map(row));
      next = r.next;
      more.hidden = next === null;
      note.textContent = list.childElementCount === 0 ? (field.value.trim() ? '見つかりませんでした。' : 'まだ商品が登録されていません。バーコードを読むと、その場で登録できます。') : '';
    } catch (e) {
      if (mine !== seq) return;
      note.textContent = e instanceof Error ? e.message : String(e);
    }
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  field.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => void load(0), 300); });
  more.addEventListener('click', () => { if (next !== null) void load(next); });
  return panel('登録済みの商品から探す', async (body) => {
    body.append(field, note, list, more);
    await load(0);
  });
}

interface HistoryRow {
  field: string; before: unknown; after: unknown; edited_at: string; edited_by: string;
  before_name?: string | null; after_name?: string | null;
}

const quote = (v: unknown): string => (typeof v === 'string' && v !== '' ? `「${v}」` : '（なし）');

/** 履歴の1行を、何がどう変わったかの文にする */
function describeChange(r: HistoryRow): string {
  switch (r.field) {
    case 'created': return '登録した';
    case 'name': return `商品名 ${quote(r.before)} → ${quote(r.after)}`;
    case 'maker': return `メーカー ${quote(r.before)} → ${quote(r.after)}`;
    case 'note': return `売場のメモ ${quote(r.before)} → ${quote(r.after)}`;
    case 'area': {
      const name = (id: unknown, label: string | null | undefined): string => (id === null || id === undefined ? '未登録' : label ? `「${label}」` : '（消した売場）');
      return `売場 ${name(r.before, r.before_name)} → ${name(r.after, r.after_name)}`;
    }
    case 'tags': {
      const tags = (v: unknown): string => (Array.isArray(v) && v.length > 0 ? v.map((t) => `#${t}`).join(' ') : '（なし）');
      return `タグ ${tags(r.before)} → ${tags(r.after)}`;
    }
    case 'store_removed': return 'この店舗の売場の情報を消した';
    default: return r.field;
  }
}

export interface ProductExtrasOptions {
  storeId: string;
  product: ProductCard;
  /** バーコードを読んだときに出た関連ナレッジ（結んであるものには linked が付く） */
  related: Hit[];
  /** 結ぶ・外すができるか（trusted 以上） */
  canLink: boolean;
  adminScope: 'none' | 'store' | 'tenant';
  /** 結ぶ・外す・売場の情報を消したあと、商品の画面を取り直す */
  onChanged: () => void;
  /** 商品そのものを消したあと */
  onDeleted: () => void;
}

/** 商品を直す画面の下に置くもの：結ぶナレッジ、変更の履歴、消す */
export function productExtras(o: ProductExtrasOptions): HTMLElement[] {
  const out: HTMLElement[] = [];
  const isHq = o.adminScope === 'tenant';
  // 全店共通のナレッジを結ぶ・外すのは本部だけ。できない人には、押せるものを出さない
  const canTouch = (hit: Hit): boolean => o.canLink && (!hit.allStores || isHq);

  if (o.canLink && !o.product.pending) {
    const linkedList = h('ul', { class: 'rows' });
    const candidateList = h('ul', { class: 'rows' });
    const linkedIds = new Set(o.related.filter((x) => x.linked).map((x) => x.id));
    const link = (hit: Hit) => action('結ぶ', 'secondary small', async () => {
      await api('POST', `/knowledge/${hit.id}/products/${o.product.id}`);
      toast('結びました');
      o.onChanged();
    });
    const hitRow = (hit: Hit, button: HTMLElement | null): HTMLElement => h('li', { class: 'row' },
      h('a', { href: `#/k/${hit.id}` }, hit.title),
      hit.allStores ? h('span', { class: 'hint' }, '全店共通') : null,
      button ? h('span', { class: 'row-actions' }, button) : null);
    const linked = o.related.filter((x) => x.linked);
    linkedList.append(...linked.map((hit) => hitRow(hit, canTouch(hit)
      ? action('外す', 'secondary small', async () => {
          await api('DELETE', `/knowledge/${hit.id}/products/${o.product.id}`);
          toast('外しました');
          o.onChanged();
        })
      : null)));
    const candidates = o.related.filter((x) => !x.linked);
    candidateList.append(...candidates.map((hit) => hitRow(hit, canTouch(hit) ? link(hit) : null)));

    // 関連に出てこないナレッジは、言葉で探して結ぶ
    const field = h('input', { type: 'search', maxlength: 100, placeholder: '結びたいナレッジを探す', 'aria-label': '結びたいナレッジを探す言葉', autocomplete: 'off', enterkeyhint: 'search' });
    const found = h('ul', { class: 'rows' });
    const foundNote = h('p', { class: 'hint' });
    const form = h('form', { class: 'search-bar' }, field, h('button', { type: 'submit', class: 'secondary' }, '探す'));
    submitOnce(form, async () => {
      const q = field.value.trim();
      clear(found);
      foundNote.textContent = '';
      if (!q) return;
      try {
        // 探すだけなので、検索の記録（見つからなかった検索など）には残さない
        const r = await api<SearchResult>('GET', `/stores/${o.storeId}/search?q=${encodeURIComponent(q)}&record=0`);
        const hits = r.hits.filter((x) => !linkedIds.has(x.id));
        found.append(...hits.map((hit) => hitRow(hit, canTouch(hit) ? link(hit) : null)));
        if (hits.length === 0) foundNote.textContent = '見つかりませんでした。';
      } catch (e) {
        foundNote.textContent = e instanceof Error ? e.message : String(e);
      }
    });

    out.push(h('section', { class: 'product-links' },
      h('h2', {}, 'この商品に結ぶナレッジ'),
      h('p', { class: 'hint' }, '結んだナレッジは、この商品のバーコードを読んだときに、いちばん上に出ます。'),
      h('h3', {}, `結んであるもの（${linked.length}件）`),
      linked.length === 0 ? h('p', { class: 'hint' }, 'まだありません。') : linkedList,
      ...(candidates.length > 0 ? [h('h3', {}, 'タグや名前が近いもの'), candidateList] : []),
      h('h3', {}, 'ほかのナレッジを探して結ぶ'),
      form, foundNote, found));
  }

  out.push(panel('変更の履歴', async (body) => {
    const rows = await api<HistoryRow[]>('GET', `/stores/${o.storeId}/products/${o.product.id}/history`);
    body.append(rows.length === 0
      ? h('p', { class: 'hint' }, 'まだありません。')
      : h('ul', { class: 'rows' }, ...rows.map((r) => h('li', { class: 'row' },
          h('span', {}, describeChange(r)),
          h('span', { class: 'hint' }, `${r.edited_by}さん・${relativeDate(r.edited_at)}`)))));
  }));

  // 商品そのものは、すべての店舗で共有している。消せるのは本部だけで、店長は自分の店舗の売場の情報だけを消せる
  if (isHq) {
    out.push(h('section', { class: 'danger-section' },
      h('h2', {}, 'この商品を消す'),
      h('p', { class: 'hint' }, '商品の登録を、すべての店舗から消します。元に戻せません。結んであったナレッジは消えません。'),
      confirmAction('消す', 'secondary', '元に戻せません。消しますか？', async () => {
        await api('DELETE', `/stores/${o.storeId}/products/${o.product.id}`);
        toast('商品を消しました');
        o.onDeleted();
      })));
  } else if (o.adminScope === 'store' && (o.product.area !== null || o.product.note !== null)) {
    out.push(h('section', { class: 'danger-section' },
      h('h2', {}, 'この店舗の売場の情報を消す'),
      h('p', { class: 'hint' }, 'この店舗での売場と、売場のメモを消します。商品の登録とタグは残ります（商品そのものを消せるのは本部です）。'),
      confirmAction('売場の情報を消す', 'secondary', '売場と売場のメモを消しますか？', async () => {
        await api('DELETE', `/stores/${o.storeId}/products/${o.product.id}`);
        toast('売場の情報を消しました');
        o.onChanged();
      })));
  }
  return out;
}

/** 売場の名前を作る・変える・消す（店長・本部）。承認・管理に置く */
export function areaPanel(storeId: string): HTMLElement {
  return panel('売場', async function load(body: HTMLElement): Promise<void> {
    const areas = await api<Area[]>('GET', `/stores/${storeId}/areas`);
    const reload = async (): Promise<void> => {
      try {
        await load(body);
      } catch (e) {
        clear(body);
        body.append(h('p', { class: 'error', role: 'alert' }, e instanceof Error ? e.message : String(e)));
      }
    };
    const name = h('input', { type: 'text', maxlength: 40, placeholder: '例：大型家電', 'aria-label': '新しい売場の名前', autocomplete: 'off' });
    const addForm = h('form', { class: 'search-bar' }, name, h('button', { type: 'submit', class: 'secondary' }, '売場を足す'));
    submitOnce(addForm, async () => {
      if (!name.value.trim()) return;
      try {
        await api('POST', `/stores/${storeId}/areas`, { name: name.value });
        toast('売場を足しました');
        await reload();
      } catch (e) {
        toast(e instanceof Error ? e.message : String(e));
      }
    });
    clear(body);
    body.append(
      h('p', { class: 'hint' }, '店舗の中の場所の名前です。商品に「どの売場にあるか」、共有メモに「どの売場の話か」を付けられるようになります。'),
      areas.length === 0
        ? h('p', { class: 'hint' }, 'まだありません。')
        : h('ul', { class: 'rows' }, ...areas.map((a) => {
            const input = h('input', { type: 'text', maxlength: 40, value: a.name, 'aria-label': `${a.name} の名前` });
            return h('li', { class: 'row area-row' },
              input,
              h('span', { class: 'hint' }, `商品 ${a.products}件`),
              h('span', { class: 'row-actions' },
                action('名前を変える', 'secondary small', async () => {
                  await api('PATCH', `/areas/${a.id}`, { name: input.value });
                  toast('名前を変えました');
                  await reload();
                }, reload),
                confirmAction('消す', 'secondary small',
                  a.products > 0 ? `この売場の商品 ${a.products}件は「売場：未登録」に戻ります。消しますか？` : '消しますか？',
                  async () => {
                    await api('DELETE', `/areas/${a.id}`);
                    toast('売場を消しました');
                    await reload();
                  }, `${a.name} を消す`, reload)));
          })),
      addForm);
  });
}

/**
 * ナレッジに「どの売場の話か」を付ける欄。売場が1つも無い店舗では、何も出さない。
 * 返す selected() は、選ばれている売場の ID（欄を出していないときは undefined ＝送らない）。
 */
export function areaPicker(storeId: string, initial: string[]): { el: HTMLElement; selected: () => string[] | undefined } {
  const picked = new Set(initial);
  const box = h('div', { class: 'area-pick', hidden: true });
  let shown = false;
  void loadAreas(storeId).then((areas) => {
    if (areas.length === 0) return;
    shown = true;
    // 消された売場の ID は、選べる一覧に無いので落とす
    for (const id of [...picked]) if (!areas.some((a) => a.id === id)) picked.delete(id);
    const draw = (): void => {
      clear(box);
      box.append(
        h('span', { class: 'label-like' }, '売場（どの売場の話か。付けなくてもかまいません）'),
        h('div', { class: 'label-pick', role: 'group', 'aria-label': '売場' }, ...areas.map((a) => h('button', {
          type: 'button', class: `label-chip${picked.has(a.id) ? ' label-chip-on' : ''}`, 'aria-pressed': picked.has(a.id) ? 'true' : 'false',
          onclick: () => { if (picked.has(a.id)) picked.delete(a.id); else picked.add(a.id); draw(); },
        }, a.name))));
    };
    draw();
    box.hidden = false;
  });
  return { el: box, selected: () => (shown ? [...picked] : undefined) };
}
