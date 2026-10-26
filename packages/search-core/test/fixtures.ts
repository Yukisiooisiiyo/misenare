import { TagDictionary, type TagEntry, type TagRelation } from '../src/tagDictionary.ts';
import { SegmenterTokenizer } from '../src/tokenizer.ts';

export const tags: TagEntry[] = [
  { id: 't-tv', name: 'テレビ', useCount: 40 },
  { id: 't-tvstand', name: 'テレビ台', useCount: 3 },
  { id: 't-repair', name: '修理', useCount: 55 },
  { id: 't-ext', name: '延長保証', useCount: 20 },
  { id: 't-long', name: '長期保証', useCount: 4 },
  { id: 't-fridge', name: '冷蔵庫', readings: ['レイゾウコ'], useCount: 30 },
  { id: 't-freezer', name: '冷凍冷蔵庫', readings: ['レイトウレイゾウコ'], useCount: 6 },
  { id: 't-ac', name: 'エアコン', useCount: 25 },
  { id: 't-cooler', name: 'クーラー', useCount: 2 },
  { id: 't-vacuum', name: '掃除機', readings: ['ソウジキ'], useCount: 12 },
  { id: 't-robot', name: 'ロボット掃除機', useCount: 5 },
  { id: 't-recycle', name: 'リサイクル', useCount: 15 },
  { id: 't-delivery', name: '配送', useCount: 18 },
  { id: 't-carry', name: '搬入', useCount: 9 },
];

export const relations: TagRelation[] = [
  { kind: 'synonym', fromTagId: 't-ext', toTagId: 't-long' },
  { kind: 'synonym', fromTagId: 't-ac', toTagId: 't-cooler' },
  { kind: 'includes', fromTagId: 't-fridge', toTagId: 't-freezer' },
  { kind: 'includes', fromTagId: 't-vacuum', toTagId: 't-robot' },
  { kind: 'alias', fromText: '映らない', toTagId: 't-repair' },
];

export function deps() {
  return { tokenizer: new SegmenterTokenizer(), dictionary: new TagDictionary(tags, relations) };
}
