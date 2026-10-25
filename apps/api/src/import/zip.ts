// ZIP の読み取り（.docx と .xlsx は中身が ZIP なので、取り込みに必要）。
// 必要なのは「中に入っている名前を指定して中身を取り出す」だけなので、
// 末尾の中央ディレクトリだけを読み、圧縮は zlib に任せる。ライブラリは足さない。

import { inflateRawSync } from 'node:zlib';

const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const END_OF_CENTRAL_DIRECTORY_64 = 0x06064b50;
const CENTRAL_FILE_HEADER = 0x02014b50;
const LOCAL_FILE_HEADER = 0x04034b50;

/** 展開後の大きさの上限（圧縮爆弾よけ） */
const MAX_ENTRY_BYTES = 64 * 1024 * 1024;

export interface ZipEntry {
  name: string;
  compressionMethod: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

/** 末尾から中央ディレクトリの位置を探す（コメントが付いていることがあるので後ろから読む） */
function findEndOfCentralDirectory(buf: Buffer): number {
  const start = Math.max(0, buf.length - 0xffff - 22);
  for (let i = buf.length - 22; i >= start; i--) {
    if (buf.readUInt32LE(i) === END_OF_CENTRAL_DIRECTORY) return i;
  }
  throw new Error('ZIP ファイルとして読めませんでした');
}

export function listZipEntries(buf: Buffer): ZipEntry[] {
  const eocd = findEndOfCentralDirectory(buf);
  let count = buf.readUInt16LE(eocd + 10);
  let directoryOffset = buf.readUInt32LE(eocd + 16);

  // ZIP64（項目が多い・大きいとき）。直前の「ZIP64 end of central directory locator」から本体を引く
  if (count === 0xffff || directoryOffset === 0xffffffff) {
    const locator = eocd - 20;
    if (locator < 0 || buf.readUInt32LE(locator) !== 0x07064b50) throw new Error('ZIP ファイルとして読めませんでした');
    const zip64 = Number(buf.readBigUInt64LE(locator + 8));
    if (buf.readUInt32LE(zip64) !== END_OF_CENTRAL_DIRECTORY_64) throw new Error('ZIP ファイルとして読めませんでした');
    count = Number(buf.readBigUInt64LE(zip64 + 32));
    directoryOffset = Number(buf.readBigUInt64LE(zip64 + 48));
  }

  const entries: ZipEntry[] = [];
  let p = directoryOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CENTRAL_FILE_HEADER) throw new Error('ZIP ファイルとして読めませんでした');
    const nameLength = buf.readUInt16LE(p + 28);
    const extraLength = buf.readUInt16LE(p + 30);
    const commentLength = buf.readUInt16LE(p + 32);
    entries.push({
      name: buf.toString('utf8', p + 46, p + 46 + nameLength),
      compressionMethod: buf.readUInt16LE(p + 10),
      compressedSize: buf.readUInt32LE(p + 20),
      uncompressedSize: buf.readUInt32LE(p + 24),
      localHeaderOffset: buf.readUInt32LE(p + 42),
    });
    p += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** 名前を指定して中身を取り出す。無ければ undefined */
export function readZipEntry(buf: Buffer, name: string): Buffer | undefined {
  const entry = listZipEntries(buf).find((e) => e.name === name);
  if (!entry) return undefined;

  const local = entry.localHeaderOffset;
  if (buf.readUInt32LE(local) !== LOCAL_FILE_HEADER) throw new Error('ZIP ファイルとして読めませんでした');
  // ローカルヘッダの名前・拡張領域の長さは中央ディレクトリと違うことがあるので、こちらを見る
  const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
  const body = buf.subarray(start, start + entry.compressedSize);

  if (entry.uncompressedSize > MAX_ENTRY_BYTES) throw new Error('ファイルが大きすぎます');
  if (entry.compressionMethod === 0) return Buffer.from(body);
  if (entry.compressionMethod === 8) return inflateRawSync(body, { maxOutputLength: MAX_ENTRY_BYTES });
  throw new Error(`この ZIP の圧縮方式には対応していません（${entry.compressionMethod}）`);
}
