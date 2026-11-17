// 資料を読むための子プロセス。1回の取り込みで1つ起こされ、結果を返したら消える。
// 起こすのは isolated.ts（なぜ分けるかも、そちらに書いてある）。
//
// ここには DB の接続先も鍵も渡さない。受け取るのはファイルの名前と中身だけで、返すのは下書きの文字だけ。

import { writeFileSync } from 'node:fs';
import { ImportError } from './error.ts';
import { parseImport } from './parse.ts';

// 台の記憶が足りなくなったとき、OS が最初に止める相手をこのプロセスにする（本体や DB を巻き込まないため）。
// Linux だけの仕組み。ほかの OS や、書けない環境では何もしない
try { writeFileSync('/proc/self/oom_score_adj', '1000'); } catch { /* 無くても動く */ }

export type ChildReply =
  | { ok: true; drafts: unknown; warnings: unknown }
  /** message があれば、利用者にそのまま見せてよい案内。無ければ内部の事情（文面は見せない） */
  | { ok: false; message?: string };

process.once('message', (m: { fileName: string; content: Uint8Array }) => {
  let reply: ChildReply;
  try {
    const result = parseImport(m.fileName, Buffer.from(m.content.buffer, m.content.byteOffset, m.content.byteLength));
    reply = { ok: true, drafts: result.drafts, warnings: result.warnings };
  } catch (err) {
    reply = err instanceof ImportError ? { ok: false, message: err.message } : { ok: false };
  }
  // 送り終わってから消える（先に消えると、結果が届かない）
  process.send!(reply, () => process.exit(0));
});
