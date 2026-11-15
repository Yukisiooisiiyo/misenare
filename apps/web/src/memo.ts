// 個人メモ。書いた本人だけが見られる（店長にも本部にも見えない）。
//
//   今日だけ … お客様の会員番号の控えや、今日のやること。明日には消える
//   残す     … 自分で消すまで残る覚え書き

import { api } from './api.ts';
import { clear, h, relativeDate, submitOnce, toast } from './dom.ts';
import { action, confirmAction } from './manage.ts';

export interface Memo {
  id: string;
  kind: 'today' | 'keep';
  body: string;
  done: boolean;
  createdAt: string;
  updatedAt: string;
}

function bodyLines(text: string): Node[] {
  const lines = text.split('\n');
  return lines.flatMap((line, i) => (i < lines.length - 1 ? [document.createTextNode(line), h('br', {})] : [document.createTextNode(line)]));
}

export function renderMemos(container: HTMLElement): void {
  const input = h('textarea', { id: 'memo-body', rows: 3, maxlength: 2000, placeholder: '例：会員番号 1234-5678／14時に高橋様へ折り返し', 'aria-label': 'メモの内容' });
  const kindToday = h('input', { type: 'radio', name: 'memo-kind', id: 'memo-kind-today', value: 'today', checked: true });
  const kindKeep = h('input', { type: 'radio', name: 'memo-kind', id: 'memo-kind-keep', value: 'keep' });
  const lists = h('div', { 'aria-live': 'polite' });
  let seq = 0;

  const load = async (): Promise<void> => {
    const mine = ++seq;
    try {
      const memos = await api<Memo[]>('GET', '/memos');
      if (mine !== seq) return;
      draw(memos);
    } catch (e) {
      if (mine !== seq) return;
      clear(lists);
      lists.append(h('p', { class: 'error', role: 'alert' }, e instanceof Error ? e.message : String(e)));
    }
  };

  const row = (m: Memo): HTMLElement => {
    const body = h('span', { class: `memo-body${m.done ? ' done' : ''}` }, ...bodyLines(m.body));
    const li = h('li', { class: 'row memo' });
    const view = (): void => {
      clear(li);
      li.append(
        body,
        h('span', { class: 'hint' }, relativeDate(m.createdAt)),
        h('span', { class: 'row-actions' },
          action(m.done ? '戻す' : '済み', 'secondary small', async () => {
            await api('PATCH', `/memos/${m.id}`, { done: !m.done });
            await load();
          }, load),
          h('button', { type: 'button', class: 'secondary small', onclick: () => edit() }, '直す'),
          action(m.kind === 'today' ? '残す' : '今日だけに', 'secondary small', async () => {
            await api('PATCH', `/memos/${m.id}`, { kind: m.kind === 'today' ? 'keep' : 'today' });
            toast(m.kind === 'today' ? '残すメモに移しました' : '今日だけのメモに移しました（明日には消えます）');
            await load();
          }, load),
          confirmAction('消す', 'secondary small', '消しますか？（元に戻せません）', async () => {
            await api('DELETE', `/memos/${m.id}`);
            toast('消しました');
            await load();
          }, undefined, load)));
    };
    const edit = (): void => {
      const area = h('textarea', { rows: 3, maxlength: 2000, value: m.body, 'aria-label': 'メモを直す' });
      const form = h('form', { class: 'write memo-edit' }, area,
        h('div', { class: 'row-actions' },
          h('button', { type: 'submit', class: 'primary small' }, '保存'),
          h('button', { type: 'button', class: 'secondary small', onclick: () => view() }, 'やめる')));
      submitOnce(form, async () => {
        const text = area.value.trim();
        if (!text) return;
        try {
          await api('PATCH', `/memos/${m.id}`, { body: text });
          toast('直しました');
          await load();
        } catch (e) {
          toast(e instanceof Error ? e.message : String(e));
        }
      });
      clear(li);
      li.append(form);
      area.focus();
    };
    view();
    return li;
  };

  const draw = (memos: Memo[]): void => {
    clear(lists);
    const today = memos.filter((m) => m.kind === 'today');
    const keep = memos.filter((m) => m.kind === 'keep');
    lists.append(
      h('h2', {}, `今日だけ（${today.length}件）`),
      today.length === 0
        ? h('p', { class: 'hint' }, 'ありません。今日だけのメモは、明日になると消えます。')
        : h('ul', { class: 'rows' }, ...today.map(row)),
      h('h2', {}, `残しているメモ（${keep.length}件）`),
      keep.length === 0
        ? h('p', { class: 'hint' }, 'ありません。')
        : h('ul', { class: 'rows' }, ...keep.map(row)));
  };

  const form = h('form', { class: 'write memo-form' },
    input,
    h('div', { class: 'memo-kinds', role: 'radiogroup', 'aria-label': 'メモの種類' },
      h('label', { class: 'memo-kind', for: 'memo-kind-today' }, kindToday, '今日だけ（明日には消えます）'),
      h('label', { class: 'memo-kind', for: 'memo-kind-keep' }, kindKeep, '残す')),
    h('button', { type: 'submit', class: 'primary' }, 'メモする'));
  submitOnce(form, async () => {
    const text = input.value.trim();
    if (!text) return;
    try {
      await api('POST', '/memos', { body: text, kind: kindKeep.checked ? 'keep' : 'today' });
      input.value = '';
      toast('メモしました');
      await load();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    }
  });

  container.append(
    h('h1', {}, '個人メモ'),
    h('p', { class: 'hint' }, 'あなただけが見られるメモです。店長や本部、ほかのスタッフには見えません。'),
    form,
    lists);
  void load();
}
