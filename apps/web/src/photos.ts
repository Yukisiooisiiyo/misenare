// 写真。端末で縮小してから送る（通信量を抑え、売場での待ち時間を短くするため）。
//
// 送り先は保存先によって変わる：
//   ローカル保存 … この API に中身を送る（ログインの印が要る）
//   S3          … 返ってきた署名付きURLへ直接送る（API を通らない）
// 閲覧も同じで、相対パスなら印を付けて取ってから表示し、絶対URLならそのまま表示する。

import { api, session } from './api.ts';
import { h, relativeDate, toast } from './dom.ts';

export interface Photo {
  id: string;
  url: string;
  contentType: string;
  bytes: number;
  caption: string | null;
  createdBy: string | null;
  createdAt: string;
}

interface UploadPlan {
  photoId: string;
  method: 'PUT';
  url: string;
  headers: Record<string, string>;
  withSession: boolean;
}

/** 縮小後の長辺（売場の値札や型番が読める程度） */
const MAX_EDGE = 1600;
const QUALITY = 0.82;
export const MAX_PHOTOS = 8;

/**
 * 写真を縮小して JPEG にする。
 * 向きの情報（EXIF）は createImageBitmap に任せるので、横倒しのまま送られることはない。
 */
export async function shrink(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  try {
    const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('この端末では写真を縮小できません');
    ctx.drawImage(bitmap, 0, 0, width, height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', QUALITY));
    if (!blob) throw new Error('写真を変換できませんでした');
    return blob;
  } finally {
    bitmap.close();
  }
}

/** 1枚送る。縮小 → 枠の申告 → 中身 → 完了 */
export async function uploadPhoto(knowledgeId: string, file: File): Promise<Photo> {
  const blob = await shrink(file);
  const plan = await api<UploadPlan>('POST', `/knowledge/${knowledgeId}/photos`, { contentType: 'image/jpeg', bytes: blob.size });
  const headers: Record<string, string> = { ...plan.headers };
  if (plan.withSession && session.token) headers.authorization = `Bearer ${session.token}`;
  const target = plan.withSession ? `/api${plan.url}` : plan.url;
  let res: Response;
  try {
    res = await fetch(target, { method: plan.method, headers, body: blob });
  } catch {
    throw new Error('写真を送れませんでした。電波の届く場所で、もう一度お試しください。');
  }
  if (!res.ok) throw new Error(`写真を送れませんでした（${res.status}）`);
  return api<Photo>('POST', `/photos/${plan.photoId}/complete`, {});
}

/** 表示用の URL。相対パスのときはログインの印を付けて取り、画面の中だけで使う URL にする */
export async function photoSrc(photo: Photo): Promise<{ src: string; revoke: () => void }> {
  if (/^https?:\/\//.test(photo.url)) return { src: photo.url, revoke: () => {} };
  const headers: Record<string, string> = {};
  if (session.token) headers.authorization = `Bearer ${session.token}`;
  const res = await fetch(`/api${photo.url}`, { headers });
  if (!res.ok) throw new Error(`写真を読み込めませんでした（${res.status}）`);
  const url = URL.createObjectURL(await res.blob());
  return { src: url, revoke: () => URL.revokeObjectURL(url) };
}

/**
 * ナレッジの写真の一覧と追加。
 * canEdit が false なら見るだけ。戻り値の dispose は画面を離れるときに呼ぶ。
 */
export function photoSection(knowledgeId: string, canEdit: boolean): { el: HTMLElement; dispose: () => void } {
  const grid = h('div', { class: 'photos' });
  const status = h('p', { class: 'hint', hidden: true });
  const el = h('section', { class: 'photo-section' }, grid, status);
  const revokers: Array<() => void> = [];
  let photos: Photo[] = [];

  const file = h('input', { type: 'file', accept: 'image/*', capture: 'environment', id: 'photo-file', hidden: true, multiple: true });
  const addButton = h('button', { type: 'button', class: 'secondary' }, '写真を追加');
  addButton.addEventListener('click', () => file.click());

  const setBusy = (text: string | null) => {
    status.textContent = text ?? '';
    status.hidden = text === null;
    addButton.disabled = text !== null;
  };

  const draw = () => {
    while (grid.firstChild) grid.firstChild.remove();
    for (const p of photos) {
      const img = h('img', { class: 'photo', alt: p.caption ?? `${p.createdBy ?? ''}さんが${relativeDate(p.createdAt)}に付けた写真`, loading: 'lazy' });
      void photoSrc(p).then(({ src, revoke }) => { img.src = src; revokers.push(revoke); }).catch(() => { img.alt = '写真を読み込めませんでした'; });
      const figure = h('figure', { class: 'photo-item' },
        img,
        p.caption ? h('figcaption', {}, p.caption) : null,
        canEdit
          ? h('button', {
              type: 'button', class: 'photo-remove', 'aria-label': 'この写真を外す',
              onclick: async () => {
                if (!window.confirm('この写真を消します。元には戻せません。')) return;
                try {
                  await api('DELETE', `/photos/${p.id}`);
                  photos = photos.filter((x) => x.id !== p.id);
                  draw();
                  toast('消しました');
                } catch (e) {
                  toast(e instanceof Error ? e.message : String(e));
                }
              },
            }, '×')
          : null,
      );
      grid.append(figure);
    }
    if (canEdit && photos.length < MAX_PHOTOS) grid.append(h('div', { class: 'photo-add' }, addButton, file));
  };

  file.addEventListener('change', async () => {
    const chosen = [...(file.files ?? [])].slice(0, MAX_PHOTOS - photos.length);
    file.value = '';
    for (const [i, f] of chosen.entries()) {
      setBusy(chosen.length > 1 ? `写真を送っています（${i + 1}/${chosen.length}）…` : '写真を送っています…');
      try {
        photos.push(await uploadPhoto(knowledgeId, f));
        draw();
      } catch (e) {
        toast(e instanceof Error ? e.message : String(e));
        break;
      }
    }
    setBusy(null);
  });

  void api<Photo[]>('GET', `/knowledge/${knowledgeId}/photos`).then((list) => { photos = list; draw(); }).catch(() => { draw(); });
  draw();

  return { el, dispose: () => { for (const r of revokers) r(); } };
}
