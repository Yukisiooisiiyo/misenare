// 開発・テスト用：psql コマンドを1本起動したままにして SQL を流す実装。
// npm パッケージ（pg）を入れられない環境でも、本物の PostgreSQL に対して同じ SQL を検証できる。
// パラメータは文字列リテラルに展開するため、本番では使わないこと（PgDatabase を使う）。

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Database, Db } from './db.ts';

function literal(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error(`non-finite number: ${v}`);
    return String(v);
  }
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (v instanceof Date) return quote(v.toISOString());
  // bytea は16進の書き方で渡す（standard_conforming_strings が on なので \x はそのまま届く）
  if (Buffer.isBuffer(v)) return quote(`\\x${v.toString('hex')}`);
  if (v instanceof Uint8Array) return quote(`\\x${Buffer.from(v).toString('hex')}`);
  if (Array.isArray(v)) {
    const items = v.map((x) => (x === null ? 'NULL' : `"${String(x).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`));
    return quote(`{${items.join(',')}}`);
  }
  if (typeof v === 'object') return quote(JSON.stringify(v));
  return quote(String(v));
}

function quote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

export function interpolate(sql: string, params: readonly unknown[] = []): string {
  const used = new Set<number>();
  const text = sql.replace(/\$(\d+)/g, (_, n: string) => {
    const i = Number(n) - 1;
    if (i < 0 || i >= params.length) throw new Error(`missing parameter $${n}`);
    used.add(i);
    return literal(params[i]);
  });
  // 本番の pg ドライバーは、余った値があると「bind message supplies N parameters…」で落ちる。
  // ここでも同じように止めておかないと、開発では通って本番で落ちる問い合わせができてしまう。
  if (used.size !== params.length) {
    const unused = params.map((_, i) => i).filter((i) => !used.has(i)).map((i) => `$${i + 1}`);
    throw new Error(`unused parameter ${unused.join(', ')}: ${sql.trim().slice(0, 60)}`);
  }
  return text;
}

const END = '__MISENARE_END__';
const ERR = '__MISENARE_ERR__';

export class PsqlDatabase implements Database {
  private readonly proc: ChildProcessWithoutNullStreams;
  private buffer = '';
  private waiter: ((chunk: string) => void) | undefined;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(connectionString: string) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('PsqlDatabase は開発・テスト専用です。本番では PgDatabase（DB_DRIVER=pg）を使ってください。');
    }
    this.proc = spawn('psql', [connectionString, '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=0'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk: string) => {
      this.buffer += chunk;
      const idx = this.buffer.indexOf(`${END} `);
      const nl = idx >= 0 ? this.buffer.indexOf('\n', idx) : -1;
      if (idx >= 0 && nl >= 0 && this.waiter) {
        const done = this.buffer.slice(0, nl + 1);
        this.buffer = this.buffer.slice(nl + 1);
        const w = this.waiter;
        this.waiter = undefined;
        w(done);
      }
    });
    this.proc.stderr.resume(); // エラー内容は LAST_ERROR_MESSAGE から取る
  }

  /** 1文を実行して行を返す。SELECT と RETURNING 付きの文は JSON で受け取る。 */
  private run(sql: string, params?: readonly unknown[]): Promise<unknown[]> {
    const text = interpolate(sql, params).trim().replace(/;\s*$/, '');
    const returnsRows = /^(select|with)\b/i.test(text) || /\breturning\b/i.test(text);
    const statement = returnsRows
      ? `WITH __q AS (${text}) SELECT coalesce(json_agg(__q), '[]'::json) FROM __q;`
      : `${text};`;
    const script = `${statement}\n\\if :ERROR\n\\echo ${ERR} :LAST_ERROR_MESSAGE\n\\endif\n\\echo ${END} :ERROR\n`;

    const task = this.queue.then(
      () =>
        new Promise<unknown[]>((resolve, reject) => {
          this.waiter = (out) => {
            const lines = out.split('\n').filter((l) => l.length > 0);
            const endLine = lines.pop()!;
            const errLine = lines.find((l) => l.startsWith(ERR));
            if (endLine.endsWith('true')) {
              reject(new Error(`SQL error: ${errLine?.slice(ERR.length + 1) ?? 'unknown'}\n${text.slice(0, 300)}`));
              return;
            }
            if (!returnsRows) return resolve([]);
            const json = lines.filter((l) => !l.startsWith(ERR)).join('\n');
            resolve(JSON.parse(json || '[]') as unknown[]);
          };
          this.proc.stdin.write(script);
        }),
    );
    this.queue = task.catch(() => undefined);
    return task;
  }

  /**
   * psql の接続は1本しかないので、トランザクションは1つずつ順番に実行する。
   * 並行に流すと BEGIN や app.tenant_id が別のリクエストと混ざり、他社の権限で実行されかねない。
   */
  private txChain: Promise<unknown> = Promise.resolve();

  /** 取引を開いているあいだ true。raw() の誤用をその場で知らせるために持つ */
  private inTransaction = false;

  withTenant<T>(tenantId: string, fn: (db: Db) => Promise<T>): Promise<T> {
    const task = this.txChain.then(async () => {
      const db: Db = { query: async <R>(sql: string, params?: readonly unknown[]) => (await this.run(sql, params)) as R[] };
      await this.run('BEGIN');
      this.inTransaction = true;
      try {
        await this.run("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
        const result = await fn(db);
        await this.run('COMMIT');
        return result;
      } catch (err) {
        await this.run('ROLLBACK');
        throw err;
      } finally {
        this.inTransaction = false;
      }
    });
    this.txChain = task.catch(() => undefined);
    return task;
  }

  /**
   * テナントを設定せずに実行する（マイグレーション、テストの準備、
   * ログイン前の処理など、まだ会社が決まっていないもの）。
   *
   * withTenant と同じ順番待ちに並べる。psql の接続は1本しかないので、
   * これを飛ばすと他の取引の BEGIN と COMMIT のあいだに割り込み、
   * 相手のトランザクションの中で実行されてしまう。
   * （実際、パスキーの合言葉の削除がそうなって、取引が開いたまま残った）
   */
  raw(sql: string, params?: readonly unknown[]): Promise<unknown[]> {
    if (this.inTransaction) {
      // そのまま並べると、自分が待っている取引が自分の完了を待つ形になって永久に止まる。
      // 黙って固まるより、理由を言って落ちるほうがよい。
      return Promise.reject(new Error(
        'raw() は withTenant の中からは呼べません（psql の接続は1本しかなく、順番待ちが噛み合わずに止まります）。'
        + `取引の中では db.query を使ってください: ${sql.trim().slice(0, 120)}`,
      ));
    }
    const task = this.txChain.then(() => this.run(sql, params));
    this.txChain = task.catch(() => undefined);
    return task;
  }

  async close(): Promise<void> {
    this.proc.stdin.end();
    await new Promise((r) => this.proc.once('close', r));
  }
}
