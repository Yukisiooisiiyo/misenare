// 資料の読み取りを、本体とは別のプロセスで行う。
//
// なぜ分けるか：読み取り（展開して、字を拾って、見出しで区切る）は一息に走る処理で、
// 資料の形によっては数秒かかり、記憶を何百 MB も使う。本体の中でやると、
//   * 終わるまで、ほかの全員の要求が止まる
//   * 記憶が上限に達すると、本体ごと落ちる（小さなファイルでも、そうなる形を作れる）
// 取り込めるのは trusted 以上だが、端末が乗っ取られれば同じ経路が台を落とす道具になる。
// そこで、使える記憶と時間を決めた子プロセスに閉じ込める。超えたら子だけを止めて、利用者には「大きすぎます」と返す。
//
// 子は1回の取り込みで1つ。同時に走らせるのは1つだけにする（並べると、上限 × 本数の記憶を使う）。

import { fork } from 'node:child_process';
import { setPriority } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { ChildReply } from './child.ts';
import { ImportError } from './error.ts';
import { MAX_BODY_CHARS, MAX_DRAFTS, MAX_TITLE_CHARS, type Draft, type ParseResult } from './parse.ts';

export interface IsolationLimits {
  /** 読み取りにかけてよい時間（ミリ秒） */
  timeoutMs?: number;
  /** 子プロセスが使ってよい記憶（MB。JavaScript の値を置く場所の大きさ） */
  heapMb?: number;
  /** 前の読み取りが終わるのを待つ時間（ミリ秒） */
  waitMs?: number;
}

/** 読み取りにかけてよい時間。上限いっぱいの大きさでも、ふつうの資料は1秒かからない（小さな台でも数秒） */
export const IMPORT_TIMEOUT_MS = 20_000;
/**
 * 子プロセスの記憶の上限（JavaScript の値を置く場所）。上限いっぱい（8MB）のふつうの資料は 64MB でも読めたので、その1.5倍。
 * 測った数字は docs/deploy.md の11章にある。大きい台で増やしたいときは IMPORT_HEAP_MB で変えられる。
 */
export const IMPORT_HEAP_MB = 96;
/** 順番を待つ時間と、待てる人数。超えたら「いま読み取り中」と返す */
const IMPORT_WAIT_MS = 15_000;
const MAX_WAITING = 3;
/** 注意書きの数と長さ（子が返したものを、そのまま信じない） */
const MAX_WARNINGS = 20;
const MAX_WARNING_CHARS = 200;

const BUSY = 'いま、ほかの資料を読み取っています。少し待ってから、もう一度お試しください。';
const TOO_BIG = '資料が大きすぎて読み取れませんでした。ページや行を分けて、もう一度お試しください。';
const TOO_SLOW = '資料の読み取りに時間がかかりすぎました。ページや行を分けて、もう一度お試しください。';

let running = false;
const waiting: Array<() => void> = [];

/** 読み取りの順番を取る。返ってきた関数を呼ぶと、次の人に渡る */
async function takeTurn(waitMs: number): Promise<() => void> {
  const release = (): void => {
    const next = waiting.shift();
    if (next) next();
    else running = false;
  };
  if (!running) {
    running = true;
    return release;
  }
  if (waiting.length >= MAX_WAITING) throw new ImportError(BUSY);
  await new Promise<void>((resolve, reject) => {
    const turn = (): void => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => {
      const i = waiting.indexOf(turn);
      if (i >= 0) waiting.splice(i, 1);
      reject(new ImportError(BUSY));
    }, waitMs);
    waiting.push(turn);
  });
  return release;
}

const text = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '');

/** 子が返したものを、形と大きさを確かめてから受け取る（試験からも呼ぶ） */
export function acceptReply(reply: { drafts: unknown; warnings: unknown }): ParseResult {
  const drafts: Draft[] = (Array.isArray(reply.drafts) ? reply.drafts : []).slice(0, MAX_DRAFTS).map((d) => {
    const o = (typeof d === 'object' && d !== null ? d : {}) as Record<string, unknown>;
    return { title: text(o.title, MAX_TITLE_CHARS), body: text(o.body, MAX_BODY_CHARS), source: text(o.source, 300) };
  }).filter((d) => d.title !== '' && d.body !== '');
  const warnings = (Array.isArray(reply.warnings) ? reply.warnings : []).slice(0, MAX_WARNINGS)
    .map((w) => text(w, MAX_WARNING_CHARS)).filter((w) => w !== '');
  return { drafts, warnings };
}

/** 子に渡す環境変数。DB の接続先や鍵は渡さない（読み取りには要らない）。試験からも呼ぶ */
export function childEnv(from: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(from)) {
    if (k === 'PATH' || k === 'HOME' || k === 'NODE_ENV' || k === 'TZ' || k === 'LANG' || k.startsWith('LC_')
      || k.startsWith('TSX_') || k === 'NODE_PATH' || k === 'NODE_V8_COVERAGE') env[k] = v;
  }
  return env;
}

function run(fileName: string, content: Buffer, timeoutMs: number, heapMb: number): Promise<ParseResult> {
  return new Promise<ParseResult>((resolve, reject) => {
    // 子も本体と同じ起こし方（tsx の読み込み口を引き継ぐ）にして、記憶の上限だけを足す。調べるための口（--inspect）は引き継がない
    const execArgv = [...process.execArgv.filter((a) => !a.startsWith('--inspect')), `--max-old-space-size=${heapMb}`];
    const child = fork(fileURLToPath(new URL('./child.ts', import.meta.url)), [], {
      execArgv,
      env: childEnv(),
      serialization: 'advanced',
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    let settled = false;
    let timedOut = false;
    let complaint = '';
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
      // 結果を受け取ったら、子は用済み（自分で消えるが、残っていれば止める）
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    };
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);

    // 子の言い分（記憶が尽きたときの知らせなど）は、頭の少しだけ覚えておく
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => { if (complaint.length < 2000) complaint += chunk; });

    child.once('message', (reply: ChildReply) => finish(() => {
      if (reply !== null && typeof reply === 'object' && reply.ok === true) resolve(acceptReply(reply));
      else if (reply !== null && typeof reply === 'object' && typeof reply.message === 'string') reject(new ImportError(reply.message.slice(0, 300)));
      else reject(new Error('資料の読み取りに失敗しました'));
    }));
    child.once('error', (err) => finish(() => reject(new Error(`資料を読むプロセスを起こせませんでした: ${err.message}`))));
    child.once('exit', (code, signal) => finish(() => {
      if (timedOut) return reject(new ImportError(TOO_SLOW));
      // 記憶の上限に達した（V8 が自分で止まる）か、台の記憶が足りずに OS に止められた
      const outOfMemory = /heap out of memory|heap limit|allocation failed/i.test(complaint) || signal === 'SIGKILL' || signal === 'SIGABRT' || code === 134;
      if (outOfMemory) return reject(new ImportError(TOO_BIG));
      reject(new Error(`資料を読むプロセスが結果を返さずに終わりました（code=${code} signal=${signal}）`));
    }));

    // 本体の要求を先に通す（子の優先度を下げる）。できない環境では何もしない
    try { if (child.pid !== undefined) setPriority(child.pid, 10); } catch { /* そのまま走らせる */ }
    // 中身は写しを送る（もとの Buffer が、ほかと共有している領域の一部でも困らないように）
    child.send({ fileName, content: new Uint8Array(content) }, (err) => {
      if (err) finish(() => reject(new Error(`資料を読むプロセスに中身を渡せませんでした: ${err.message}`)));
    });
  });
}

/** 記憶の上限。IMPORT_HEAP_MB が 32〜1024 の数ならそれを使い、そうでなければ既定の値 */
function heapFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.IMPORT_HEAP_MB);
  return Number.isInteger(n) && n >= 32 && n <= 1024 ? n : IMPORT_HEAP_MB;
}

/**
 * 資料を、別のプロセスで読み取る。
 * 利用者に見せてよい理由で読めなかったときは ImportError、それ以外（内部の事情）はふつうの Error を投げる。
 */
export async function parseIsolated(fileName: string, content: Buffer, limits: IsolationLimits = {}): Promise<ParseResult> {
  const release = await takeTurn(limits.waitMs ?? IMPORT_WAIT_MS);
  try {
    return await run(fileName, content, limits.timeoutMs ?? IMPORT_TIMEOUT_MS, limits.heapMb ?? heapFromEnv());
  } finally {
    release();
  }
}
