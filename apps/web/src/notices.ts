// 連絡（お知らせの掲示板）と引き継ぎ（その日の申し送り）の画面。
//
// 連絡事項 … 期間のあるお知らせ。読んだら記録され、「要確認」は押してもらう
// 引き継ぎ … その日のメモ。承認はなく、誰でも書けて誰でも片付けられる

import { api } from './api.ts';
import { clear, h, relativeDate, toast } from './dom.ts';
import { action, confirmAction, countedList } from './manage.ts';

export interface Notice {
  id: string;
  storeId: string | null;
  title: string;
  body: string;
  priority: 'normal' | 'important';
  requiresAck: boolean;
  startsAt: string;
  endsAt: string | null;
  createdBy: string | null;
  createdAt: string;
  readAt: string | null;
  ackedAt: string | null;
  pendingAcks?: number;
}

export interface Handover {
  id: string;
  body: string;
  state: 'open' | 'done';
  forDate: string;
  createdBy: string | null;
  createdAt: string;
  doneBy: string | null;
  doneAt: string | null;
  carriedOver: boolean;
}

export interface HandoverEvent { action: string; label: string; by: string | null; at: string }
export interface HandoverHistoryItem {
  id: string; body: string; state: 'open' | 'done'; forDate: string; deleted: boolean;
  createdBy: string | null; createdAt: string;
  events: HandoverEvent[];
  lastAction: HandoverEvent;
}

export interface Badges {
  notices: { unread: number; needsAck: number };
  handovers: { open: number; carriedOver: number };
  /** 利用の申請。店長・本部だけ 0 より大きくなる */
  accessRequests: { pending: number };
}

/** 本文の段落。改行をそのまま出す */
function paragraphs(text: string): HTMLElement[] {
  return text.split(/\n{2,}/).map((p) => h('p', {}, ...p.split('\n').flatMap((line, i) => (i === 0 ? [line] : [h('br', {}), line]))));
}

function noticeCard(n: Notice, canSeeReaders: boolean, onChange: () => void): HTMLElement {
  const card = h('article', { class: `notice${n.priority === 'important' ? ' notice-important' : ''}${n.readAt ? '' : ' notice-unread'}` });
  const draw = () => {
    clear(card);
    card.append(
      h('div', { class: 'notice-head' },
        n.priority === 'important' ? h('span', { class: 'notice-badge' }, '重要') : null,
        n.storeId === null ? h('span', { class: 'notice-badge notice-all' }, '全店') : null,
        !n.readAt ? h('span', { class: 'notice-badge notice-new' }, '未読') : null,
        h('h3', {}, n.title)),
      ...paragraphs(n.body),
      h('p', { class: 'hint' },
        n.createdBy ? `${n.createdBy}さん・${relativeDate(n.createdAt)}` : `ミセナレから・${relativeDate(n.createdAt)}`
        + (n.endsAt ? `・${relativeDate(n.endsAt)}まで` : '')
        + (canSeeReaders && n.pendingAcks !== undefined ? `・未確認 ${n.pendingAcks}人` : '')),
      ...(n.requiresAck
        ? [n.ackedAt
          ? h('p', { class: 'notice-acked' }, `${relativeDate(n.ackedAt)}に確認しました`)
          : action('確認しました', 'primary', async () => {
              const r = await api<{ ackedAt: string }>('POST', `/notices/${n.id}/ack`);
              n.ackedAt = r.ackedAt;
              n.readAt = n.readAt ?? r.ackedAt;
              toast('確認しました');
              draw();
              onChange();
            })]
        : []),
    );
  };
  draw();

  // 画面に出たら「読んだ」として記録する
  if (!n.readAt) {
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      observer.disconnect();
      void api('POST', `/notices/${n.id}/read`).then(() => {
        n.readAt = new Date().toISOString();
        card.classList.remove('notice-unread');
        onChange();
      }).catch(() => {});
    }, { threshold: 0.5 });
    observer.observe(card);
  }
  return card;
}

/** お知らせを出すフォーム（trusted 以上） */
function noticeForm(storeId: string, onPosted: () => void): HTMLElement {
  const title = h('input', { id: 'ntitle', type: 'text', maxlength: 100, placeholder: '例：年末年始の営業時間' });
  const body = h('textarea', { id: 'nbody', rows: 4, placeholder: '伝えたいこと' });
  const important = h('input', { id: 'nimportant', type: 'checkbox' });
  const ack = h('input', { id: 'nack', type: 'checkbox' });
  const until = h('input', { id: 'nuntil', type: 'date' });
  const message = h('p', { class: 'error', role: 'alert', hidden: true });

  const submit = async (e: Event) => {
    e.preventDefault();
    message.hidden = true;
    try {
      await api('POST', `/stores/${storeId}/notices`, {
        title: title.value,
        body: body.value,
        priority: important.checked ? 'important' : 'normal',
        requiresAck: ack.checked,
        // 日付だけを選んでもらい、その日の終わりまで出す
        endsAt: until.value ? new Date(`${until.value}T23:59:59`).toISOString() : null,
      });
      title.value = '';
      body.value = '';
      important.checked = false;
      ack.checked = false;
      until.value = '';
      toast('連絡事項を出しました');
      onPosted();
    } catch (err) {
      message.textContent = err instanceof Error ? err.message : String(err);
      message.hidden = false;
    }
  };

  return h('details', { class: 'panel' },
    h('summary', {}, '連絡事項を出す'),
    h('form', { class: 'write panel-body', onsubmit: submit },
      h('label', { for: 'ntitle' }, '件名'), title,
      h('label', { for: 'nbody' }, '本文'), body,
      h('label', { class: 'check' }, important, '重要（いちばん上に出す）'),
      h('label', { class: 'check' }, ack, '読んだら「確認しました」を押してもらう'),
      h('label', { for: 'nuntil' }, 'いつまで出すか（空なら期限なし）'), until,
      message,
      h('button', { type: 'submit', class: 'primary' }, '出す')));
}

// --- 引き継ぎ -----------------------------------------------------------------------

function handoverRow(item: Handover, canDelete: boolean, redraw: () => void): HTMLElement {
  const row = h('li', { class: `row handover${item.carriedOver ? ' handover-carried' : ''}` },
    h('span', { class: 'handover-body' },
      item.carriedOver ? h('span', { class: 'notice-badge' }, '持ち越し') : null,
      item.body),
    h('span', { class: 'hint' }, item.createdBy ? `${item.createdBy}さん・${relativeDate(item.createdAt)}` : `ミセナレから・${relativeDate(item.createdAt)}`),
    h('span', { class: 'row-actions' },
      action('片付いた', 'secondary small', async () => {
        await api('POST', `/handovers/${item.id}/done`);
        toast('片付けました');
        redraw();
      }),
      ...(canDelete
        ? [confirmAction('消す', 'secondary small', '消しますか？（履歴から戻せます）', async () => {
            await api('DELETE', `/handovers/${item.id}`);
            toast('消しました（履歴から戻せます）');
            redraw();
          })]
        : [])),
  );
  return row;
}

/**
 * 引き継ぎの履歴。誰が何をしたかを時系列で見る。
 * 「操作された分」と「すべて」を切り替えられる。押し間違いはここから戻せる。
 */
function historyPanel(storeId: string, onChange: () => void): HTMLElement {
  let scope: 'actions' | 'all' = 'actions';
  const list = h('div');
  const tabs = h('div', { class: 'scope-tabs', role: 'tablist' });

  const draw = async () => {
    clear(tabs);
    for (const [value, label] of [['actions', '操作された分'], ['all', 'すべて']] as const) {
      const on = scope === value;
      tabs.append(h('button', {
        type: 'button', role: 'tab', 'aria-selected': on ? 'true' : 'false',
        class: `scope-tab${on ? ' scope-tab-on' : ''}`,
        onclick: () => { scope = value; void draw(); },
      }, label));
    }
    clear(list);
    list.append(h('p', { class: 'hint' }, '読み込んでいます…'));
    try {
      const items = await api<HandoverHistoryItem[]>('GET', `/stores/${storeId}/handovers/history?scope=${scope}`);
      clear(list);
      if (items.length === 0) {
        list.append(h('p', { class: 'hint' }, scope === 'actions' ? 'まだ誰も操作していません。' : '引き継ぎはまだありません。'));
        return;
      }
      list.append(h('ul', { class: 'rows' }, ...items.map((item) => historyRow(item, () => { void draw(); onChange(); }))));
    } catch (e) {
      clear(list);
      list.append(h('p', { class: 'error', role: 'alert' }, e instanceof Error ? e.message : String(e)));
    }
  };

  const panel = h('details', { class: 'panel' },
    h('summary', {}, '引き継ぎの履歴（誰がいつ操作したか）'),
    h('div', { class: 'panel-body' }, tabs, list));
  let loaded = false;
  panel.addEventListener('toggle', () => {
    if (!panel.open || loaded) return;
    loaded = true;
    void draw();
  });
  return panel;
}

function historyRow(item: HandoverHistoryItem, redraw: () => void): HTMLElement {
  const state = item.deleted ? '消した' : item.state === 'done' ? '片付いた' : '残っている';
  return h('li', { class: `row history${item.deleted ? ' history-deleted' : ''}` },
    h('span', { class: 'handover-body' },
      h('span', { class: `notice-badge${item.deleted ? '' : item.state === 'done' ? ' history-done' : ' history-open'}` }, state),
      h('span', { class: 'history-text' }, item.body)),
    h('ul', { class: 'history-events' }, ...item.events.map((e) =>
      h('li', {}, `${relativeDate(e.at)}　${e.by ?? ''}さんが${e.label}`))),
    ...(item.deleted
      ? [h('span', { class: 'row-actions' }, action('戻す', 'secondary small', async () => {
          await api('POST', `/handovers/${item.id}/restore`);
          toast('戻しました');
          redraw();
        }))]
      : []),
  );
}

/** 連絡タブの中身 */
export function renderNotices(
  container: HTMLElement,
  options: { storeId: string; userName: string; isTrusted: boolean; onBadges?: () => void },
): void {
  const noticeList = h('div', { class: 'notices' });
  const handoverList = h('div');
  const input = h('textarea', { id: 'hbody', rows: 2, maxlength: 1000, placeholder: '次の人に伝えること（例：冷蔵庫の在庫が1台。発注済み）' });

  const loadNotices = async () => {
    clear(noticeList);
    try {
      const list = await api<Notice[]>('GET', `/stores/${options.storeId}/notices`);
      if (list.length === 0) {
        noticeList.append(h('p', { class: 'hint' }, '今の連絡事項はありません。'));
        return;
      }
      for (const n of list) noticeList.append(noticeCard(n, options.isTrusted, () => options.onBadges?.()));
    } catch (e) {
      noticeList.append(h('p', { class: 'error', role: 'alert' }, e instanceof Error ? e.message : String(e)));
    }
  };

  const loadHandovers = async () => {
    clear(handoverList);
    try {
      const list = await api<Handover[]>('GET', `/stores/${options.storeId}/handovers`);
      const open = list.filter((x) => x.state === 'open');
      handoverList.append(...countedList('残っている引き継ぎ', open, (item) =>
        handoverRow(item, options.isTrusted || item.createdBy === options.userName, () => {
          void loadHandovers();
          options.onBadges?.();
        }), 'h2'));
      const done = list.filter((x) => x.state === 'done');
      if (done.length > 0) {
        handoverList.append(h('details', { class: 'panel' },
          h('summary', {}, `今日の片付いたもの（${done.length}件）`),
          h('ul', { class: 'rows panel-body' }, ...done.map((item) =>
            h('li', { class: 'row' },
              h('span', { class: 'handover-body done' }, item.body),
              h('span', { class: 'hint' }, `${item.doneBy ?? ''}さんが片付けた`),
              h('span', { class: 'row-actions' },
                action('戻す', 'secondary small', async () => {
                  await api('POST', `/handovers/${item.id}/reopen`);
                  void loadHandovers();
                  options.onBadges?.();
                })))))));
      }
    } catch (e) {
      handoverList.append(h('p', { class: 'error', role: 'alert' }, e instanceof Error ? e.message : String(e)));
    }
  };

  const addSubmit = async (e: Event) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    try {
      await api('POST', `/stores/${options.storeId}/handovers`, { body: text });
      input.value = '';
      toast('書きました');
      await loadHandovers();
      options.onBadges?.();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err));
    }
  };

  container.append(
    h('h1', {}, '連絡'),
    h('h2', {}, '連絡事項'),
    noticeList,
    ...(options.isTrusted ? [noticeForm(options.storeId, () => void loadNotices())] : []),
    h('h2', {}, '引き継ぎ'),
    h('p', { class: 'hint' }, '承認はありません。誰でも書けて、誰でも片付けられます。片付かないものは次の日に持ち越します。'),
    h('form', { class: 'write handover-form', onsubmit: addSubmit },
      input,
      h('button', { type: 'submit', class: 'primary' }, '書く')),
    handoverList,
    historyPanel(options.storeId, () => { void loadHandovers(); options.onBadges?.(); }),
  );
  void loadNotices();
  void loadHandovers();
}
