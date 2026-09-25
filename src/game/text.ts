import { CHARMAP } from './symbols.js';

/** Decode a Gen 1 encoded string (terminated by $50). */
export function decode(bytes: ArrayLike<number>, start = 0, max = 64): string {
  let s = '';
  for (let i = start; i < start + max && i < bytes.length; i++) {
    const c = bytes[i];
    if (c === 0x50) break;
    s += CHARMAP[c] ?? '';
  }
  return s.trim();
}

/** Decode a tilemap row (no terminator; unknown tiles become spaces). */
export function decodeRow(tiles: ArrayLike<number>): string {
  let s = '';
  for (let i = 0; i < tiles.length; i++) s += CHARMAP[tiles[i]] ?? ' ';
  return s;
}
