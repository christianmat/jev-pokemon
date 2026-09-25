import type { Emulator } from '../emu/emulator.js';
import type { Rom } from './rom.js';
import { sym, EVENTS, mapName } from './symbols.js';
import { decode, decodeRow } from './text.js';

// Reads live game state from WRAM. Pure observation — never writes memory.

export interface MonState {
  slot: number; species: string; nickname: string; level: number; hp: number; maxHp: number;
  status: string; types: string[];
  moves: { id: number; name: string; type: string; power: number; accuracy: number; pp: number; maxPp: number }[];
  stats?: { atk: number; def: number; spd: number; spc: number };
}

export interface ScreenState {
  rows: string[];           // 18 decoded tilemap rows (20 chars)
  hasTextBox: boolean;      // box-drawing chars present
  nonMapTiles: number;      // tiles >= $60 (font/UI). Overworld map tiles are always < $60.
  dialog: string;           // text inside the bottom dialog box
  waitingForA: boolean;     // ▼ prompt visible
  cursor: { x: number; y: number } | null; // ▶ position
}

const STATUS = (b: number) =>
  b & 0x07 ? 'SLEEP' : b & 0x08 ? 'POISON' : b & 0x10 ? 'BURN' : b & 0x20 ? 'FREEZE' : b & 0x40 ? 'PARALYZED' : 'OK';

export class GameState {
  constructor(private emu: Emulator, private rom: Rom) {}

  get m() { return this.emu.mem; }
  u8(name: string, off = 0) { return this.m[sym(name) + off]; }
  be16(a: number) { return (this.m[a] << 8) | this.m[a + 1]; }

  get mapId() { return this.u8('wCurMap'); }
  get mapName() { return mapName(this.mapId); }
  get x() { return this.u8('wXCoord'); }
  get y() { return this.u8('wYCoord'); }
  get mapWidth() { return this.u8('wCurMapWidth'); }
  get mapHeight() { return this.u8('wCurMapHeight'); }
  get facing() { return ({ 0: 'down', 4: 'up', 8: 'left', 0xc: 'right' } as Record<number, string>)[this.m[0xc109]] ?? '?'; }
  get inBattle() { return this.u8('wIsInBattle'); } // 0 none, 1 wild, 2 trainer, 0xff lost
  get badges() { return this.u8('wObtainedBadges'); }
  get badgeCount() { let n = 0; for (let b = this.badges; b; b >>= 1) n += b & 1; return n; }
  get walkState() { return this.u8('wWalkBikeSurfState'); } // 0 walk 1 bike 2 surf
  get joyIgnore() { return this.u8('wJoyIgnore'); }

  get money() {
    const a = sym('wPlayerMoney');
    const bcd = (v: number) => (v >> 4) * 10 + (v & 0xf);
    return bcd(this.m[a]) * 10000 + bcd(this.m[a + 1]) * 100 + bcd(this.m[a + 2]);
  }

  event(name: string): boolean {
    const bit = EVENTS[name];
    if (bit === undefined) throw new Error(`unknown event ${name}`);
    return !!(this.m[sym('wEventFlags') + (bit >> 3)] & (1 << (bit & 7)));
  }

  /** Pokédex "owned" flag for a species id (internal index). */
  owned(dex: number): boolean {
    return !!(this.m[sym('wPokedexOwned') + ((dex - 1) >> 3)] & (1 << ((dex - 1) & 7)));
  }

  get playerName() { return decode(this.m, sym('wPlayerName'), 11); }

  party(): MonState[] {
    const n = Math.min(this.u8('wPartyCount'), 6);
    const out: MonState[] = [];
    for (let i = 0; i < n; i++) {
      const a = sym('wPartyMons') + i * 44;
      const sp = this.rom.species.get(this.m[a]);
      out.push({
        slot: i, species: sp?.name ?? '?', nickname: decode(this.m, sym('wPartyMonNicks') + i * 11, 11),
        level: this.m[a + 33], hp: this.be16(a + 1), maxHp: this.be16(a + 34), status: STATUS(this.m[a + 4]),
        types: sp?.types ?? [],
        moves: this.movesAt(a + 8, a + 29),
        stats: { atk: this.be16(a + 36), def: this.be16(a + 38), spd: this.be16(a + 40), spc: this.be16(a + 42) },
      });
    }
    return out;
  }

  private movesAt(movesAddr: number, ppAddr: number) {
    const out: MonState['moves'] = [];
    for (let j = 0; j < 4; j++) {
      const id = this.m[movesAddr + j];
      if (!id) continue;
      const mv = this.rom.moves.get(id)!;
      const ppByte = this.m[ppAddr + j];
      const ups = ppByte >> 6;
      out.push({ id, name: mv.name, type: mv.type, power: mv.power, accuracy: mv.accuracy, pp: ppByte & 0x3f, maxPp: mv.pp + Math.floor(mv.pp / 5) * ups });
    }
    return out;
  }

  /** Active battlers (only meaningful while inBattle). */
  battle() {
    const e = sym('wEnemyMon'), p = sym('wBattleMon');
    const esp = this.rom.species.get(this.m[e]);
    const psp = this.rom.species.get(this.m[p]);
    return {
      kind: this.inBattle === 1 ? 'wild' : this.inBattle === 2 ? 'trainer' : 'none',
      enemy: {
        species: esp?.name ?? '?', level: this.m[e + 14], hp: this.be16(e + 1), maxHp: this.be16(e + 15),
        status: STATUS(this.m[e + 4]), types: esp?.types ?? [], catchRate: esp?.catchRate ?? 0,
      },
      enemyPartyCount: this.u8('wEnemyPartyCount'),
      player: {
        slot: this.u8('wPlayerMonNumber'), species: psp?.name ?? '?', level: this.m[p + 14], hp: this.be16(p + 1), maxHp: this.be16(p + 15),
        status: STATUS(this.m[p + 4]), types: psp?.types ?? [], moves: this.movesAt(p + 8, p + 25),
      },
    };
  }

  bag(): { id: number; name: string; qty: number }[] {
    const n = this.u8('wNumBagItems');
    const out = [];
    for (let i = 0; i < n && i < 20; i++) {
      const a = sym('wBagItems') + i * 2;
      out.push({ id: this.m[a], name: this.rom.items.get(this.m[a]) ?? `ITEM_${this.m[a]}`, qty: this.m[a + 1] });
    }
    return out;
  }

  /** NPC/object sprites currently on the map (index 1..15). */
  sprites(): { index: number; x: number; y: number; hidden: boolean; picture: number }[] {
    const out = [];
    const n = this.u8('wNumSprites');
    const hiddenIdx = new Set<number>();
    // wToggleableObjectList: pairs (sprite index, global toggle index) terminated by $FF
    for (let a = sym('wToggleableObjectList'); this.m[a] !== 0xff && a < sym('wToggleableObjectList') + 34; a += 2) {
      const g = this.m[a + 1];
      if (this.m[sym('wToggleableObjectFlags') + (g >> 3)] & (1 << (g & 7))) hiddenIdx.add(this.m[a]);
    }
    for (let i = 1; i <= n && i < 16; i++) {
      const picture = this.m[sym('wSpriteStateData1') + i * 16];
      const y = this.m[sym('wSpriteStateData2') + i * 16 + 4] - 4;
      const x = this.m[sym('wSpriteStateData2') + i * 16 + 5] - 4;
      out.push({ index: i, x, y, hidden: hiddenIdx.has(i) || picture === 0, picture });
    }
    return out;
  }

  screen(): ScreenState {
    const base = sym('wTileMap');
    const rows: string[] = [];
    let hasTextBox = false, waitingForA = false, nonMapTiles = 0;
    let cursor: ScreenState['cursor'] = null;
    for (let y = 0; y < 18; y++) {
      const tiles = this.m.subarray(base + y * 20, base + y * 20 + 20);
      for (let x = 0; x < 20; x++) {
        const t = tiles[x];
        if (t >= 0x60) nonMapTiles++;
        if (t >= 0x79 && t <= 0x7e) hasTextBox = true;
        if (t === 0xed) cursor = { x, y };
        if (t === 0xee) waitingForA = true;
      }
      rows.push(decodeRow(tiles));
    }
    const dialog = hasTextBox ? [rows[14], rows[16]].map((r) => r.replace(/[┌─┐│└┘]/g, '').trim()).filter(Boolean).join(' ') : '';
    return { rows, hasTextBox, nonMapTiles, dialog, waitingForA, cursor };
  }

  /** Menu registers (cursor-driven menus). */
  menu() {
    return {
      current: this.u8('wCurrentMenuItem'), max: this.u8('wMaxMenuItem'),
      topY: this.u8('wTopMenuItemY'), topX: this.u8('wTopMenuItemX'),
      watched: this.u8('wMenuWatchedKeys'), listScroll: this.u8('wListScrollOffset'),
    };
  }
}
