import { sym, MAPS, symbols } from './symbols.js';
import { decode } from './text.js';

// Static game data read straight out of the ROM using pokered symbol addresses.

export const TYPE_NAMES: Record<number, string> = {
  0x00: 'NORMAL', 0x01: 'FIGHTING', 0x02: 'FLYING', 0x03: 'POISON', 0x04: 'GROUND', 0x05: 'ROCK',
  0x07: 'BUG', 0x08: 'GHOST', 0x14: 'FIRE', 0x15: 'WATER', 0x16: 'GRASS', 0x17: 'ELECTRIC',
  0x18: 'PSYCHIC', 0x19: 'ICE', 0x1a: 'DRAGON',
};

export interface MoveData { id: number; name: string; effect: number; power: number; type: string; accuracy: number; pp: number }
export interface SpeciesData { id: number; dex: number; name: string; types: string[]; base: { hp: number; atk: number; def: number; spd: number; spc: number }; catchRate: number; tmhm: Uint8Array; stoneEvos: number[] }
export interface Warp { x: number; y: number; destMap: number; destWarp: number }
export interface Sign { x: number; y: number; textId: number }
export interface MapObject { index: number; sprite: number; x: number; y: number; movement: number; textId: number; trainer: boolean; item: number | null }
export interface Connection { dir: 'north' | 'south' | 'west' | 'east'; map: number; yAlign: number; xAlign: number }
export interface MapData {
  id: number; name: string; tileset: number; width: number; height: number;
  blocksPtr: number; bank: number; connections: Connection[]; warps: Warp[]; signs: Sign[]; objects: MapObject[];
}

export class Rom {
  readonly species = new Map<number, SpeciesData>();
  readonly moves = new Map<number, MoveData>();
  readonly items = new Map<number, string>();
  readonly typeChart = new Map<string, number>(); // "ATK>DEF" -> multiplier
  readonly maps = new Map<number, MapData>();
  readonly hidden = new Map<number, { x: number; y: number; arg: number; fn: string }[]>();
  readonly tmMoves: number[] = []; // TM01..TM50 then HM01..HM05 -> move id

  constructor(readonly b: Uint8Array) {
    this.loadMoves();
    this.loadItems();
    this.loadSpecies();
    this.loadTypeChart();
    this.loadMaps();
    this.loadHidden();
    for (let i = 0; i < 55; i++) this.tmMoves.push(this.b[sym('TechnicalMachines') + i]);
  }

  /** Move taught by a TM/HM item id (or null). */
  machineMove(itemId: number): MoveData | null {
    const idx = itemId >= 0xc9 ? itemId - 0xc9 : itemId >= 0xc4 ? 50 + itemId - 0xc4 : -1;
    return idx >= 0 ? this.moves.get(this.tmMoves[idx]) ?? null : null;
  }

  private loadHidden() {
    const names = new Map<number, string>();
    for (const [n, a] of Object.entries(symbols())) if (a >= 0x4000 && !n.includes('.')) names.set(a, n);
    const maps = sym('HiddenEventMaps'), ptrs = sym('HiddenEventPointers');
    const bank = Math.floor(maps / 0x4000);
    for (let i = 0; this.b[maps + i] !== 0xff; i++) {
      const list: { x: number; y: number; arg: number; fn: string }[] = [];
      for (let a = this.flat(bank, this.u16(ptrs + i * 2)); this.b[a] !== 0xff; a += 6) {
        const fnAddr = this.flat(this.b[a + 3], this.u16(a + 4));
        list.push({ y: this.b[a], x: this.b[a + 1], arg: this.b[a + 2], fn: names.get(fnAddr) ?? 'Unknown' });
      }
      this.hidden.set(this.b[maps + i], list);
    }
  }

  u8(a: number) { return this.b[a]; }
  u16(a: number) { return this.b[a] | (this.b[a + 1] << 8); }
  /** Resolve a banked pointer to a flat ROM offset. */
  flat(bank: number, ptr: number) { return ptr < 0x4000 ? ptr : bank * 0x4000 + (ptr - 0x4000); }

  private strings(start: number, count: number): string[] {
    const out: string[] = [];
    let a = start;
    for (let i = 0; i < count; i++) {
      out.push(decode(this.b, a, 32));
      while (this.b[a] !== 0x50) a++;
      a++;
    }
    return out;
  }

  private loadMoves() {
    const names = this.strings(sym('MoveNames'), 165);
    const base = sym('Moves');
    for (let i = 0; i < 165; i++) {
      const a = base + i * 6;
      this.moves.set(i + 1, {
        id: i + 1, name: names[i], effect: this.b[a + 1], power: this.b[a + 2],
        type: TYPE_NAMES[this.b[a + 3]] ?? '?', accuracy: Math.round((this.b[a + 4] / 255) * 100), pp: this.b[a + 5],
      });
    }
  }

  private loadItems() {
    const names = this.strings(sym('ItemNames'), 97);
    names.forEach((n, i) => this.items.set(i + 1, n));
    for (let i = 1; i <= 5; i++) this.items.set(0xc3 + i, `HM0${i}`);
    for (let i = 1; i <= 50; i++) this.items.set(0xc8 + i, `TM${String(i).padStart(2, '0')}`);
  }

  private loadSpecies() {
    const namesAt = sym('MonsterNames');
    const dexOrder = sym('PokedexOrder');
    for (let id = 1; id <= 190; id++) {
      const dex = this.b[dexOrder + id - 1];
      if (!dex) continue;
      const a = dex === 151 ? sym('MewBaseStats') : sym('BaseStats') + (dex - 1) * 28;
      const t1 = TYPE_NAMES[this.b[a + 6]], t2 = TYPE_NAMES[this.b[a + 7]];
      this.species.set(id, {
        id, dex, name: decode(this.b, namesAt + (id - 1) * 10, 10),
        types: t1 === t2 ? [t1] : [t1, t2],
        base: { hp: this.b[a + 1], atk: this.b[a + 2], def: this.b[a + 3], spd: this.b[a + 4], spc: this.b[a + 5] },
        catchRate: this.b[a + 8],
        tmhm: this.b.slice(a + 20, a + 27),
        stoneEvos: this.stoneEvolutions(id),
      });
    }
  }

  /** Items (evolution stones) that evolve this species, from EvosMovesPointerTable. */
  private stoneEvolutions(id: number): number[] {
    const table = sym('EvosMovesPointerTable');
    const bank = Math.floor(table / 0x4000);
    let a = this.flat(bank, this.u16(table + (id - 1) * 2));
    const out: number[] = [];
    for (let guard = 0; this.b[a] !== 0 && guard < 8; guard++) {
      const method = this.b[a];
      if (method === 1) a += 3;                                  // EVOLVE_LEVEL, level, species
      else if (method === 2) { out.push(this.b[a + 1]); a += 4; } // EVOLVE_ITEM, item, 1, species
      else if (method === 3) a += 3;                             // EVOLVE_TRADE, 1, species
      else break;
    }
    return out;
  }

  /** Can this species learn the TM/HM item? (bit n of the tmhm flags = machine n+1) */
  canLearnMachine(speciesId: number, itemId: number): boolean {
    const idx = itemId >= 0xc9 ? itemId - 0xc9 : itemId >= 0xc4 ? 50 + itemId - 0xc4 : -1;
    const sp = this.species.get(speciesId);
    return !!sp && idx >= 0 && !!(sp.tmhm[idx >> 3] & (1 << (idx & 7)));
  }

  private loadTypeChart() {
    for (let a = sym('TypeEffects'); this.b[a] !== 0xff; a += 3) {
      this.typeChart.set(`${TYPE_NAMES[this.b[a]]}>${TYPE_NAMES[this.b[a + 1]]}`, this.b[a + 2] / 10);
    }
  }

  effectiveness(moveType: string, defTypes: string[]): number {
    return defTypes.reduce((m, t) => m * (this.typeChart.get(`${moveType}>${t}`) ?? 1), 1);
  }

  private loadMaps() {
    const banks = sym('MapHeaderBanks'), ptrs = sym('MapHeaderPointers');
    for (const [idStr, meta] of Object.entries(MAPS)) {
      const id = +idStr;
      if (meta.name.startsWith('UNUSED')) continue;
      const bank = this.b[banks + id];
      let h = this.flat(bank, this.u16(ptrs + id * 2));
      const tileset = this.b[h], height = this.b[h + 1], width = this.b[h + 2];
      const blocksPtr = this.u16(h + 3);
      const flags = this.b[h + 9];
      h += 10;
      const connections: Connection[] = [];
      for (const [bit, dir] of [[3, 'north'], [2, 'south'], [1, 'west'], [0, 'east']] as const) {
        if (flags & (1 << bit)) {
          const y = this.b[h + 7], x = this.b[h + 8];
          connections.push({ dir, map: this.b[h], yAlign: y > 127 ? y - 256 : y, xAlign: x > 127 ? x - 256 : x });
          h += 11;
        }
      }
      let o = this.flat(bank, this.u16(h));
      o++; // border block
      const warps: Warp[] = [];
      for (let n = this.b[o++], i = 0; i < n; i++, o += 4) warps.push({ y: this.b[o], x: this.b[o + 1], destWarp: this.b[o + 2], destMap: this.b[o + 3] });
      const signs: Sign[] = [];
      for (let n = this.b[o++], i = 0; i < n; i++, o += 3) signs.push({ y: this.b[o], x: this.b[o + 1], textId: this.b[o + 2] });
      const objects: MapObject[] = [];
      for (let n = this.b[o++], i = 0; i < n; i++) {
        const sprite = this.b[o], y = this.b[o + 1] - 4, x = this.b[o + 2] - 4, movement = this.b[o + 3], t = this.b[o + 5];
        let item: number | null = null, trainer = false;
        if (t & 0x40) { trainer = true; o += 8; }
        else if (t & 0x80) { item = this.b[o + 6]; o += 7; }
        else o += 6;
        objects.push({ index: i + 1, sprite, x, y, movement, textId: t & 0x3f, trainer, item });
      }
      this.maps.set(id, { id, name: meta.name, tileset, width, height, blocksPtr, bank, connections, warps, signs, objects });
    }
  }
}
