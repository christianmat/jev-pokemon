import type { Emulator } from '../emu/emulator.js';
import type { Rom } from './rom.js';
import type { GameState } from './state.js';
import { sym, mapName } from './symbols.js';

export type Dir = 'up' | 'down' | 'left' | 'right';
export const DIRS: Record<Dir, [number, number]> = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
const FACING_TO_DIR: Record<number, Dir> = { 0x0: 'down', 0x4: 'up', 0x8: 'left', 0xc: 'right' };

export interface Grid {
  mapId: number; w: number; h: number; tileset: number;
  tile: (x: number, y: number) => number;       // collision tile (bottom-left of 16x16 square)
  walkable: (x: number, y: number) => boolean;
  grass: (x: number, y: number) => boolean;
  water: (x: number, y: number) => boolean;
  cuttable: (x: number, y: number) => boolean;
  counter: (x: number, y: number) => boolean;
  ledge: (x: number, y: number, d: Dir) => boolean; // can jump from (x,y) moving d
  pairBlocked: (a: number, b: number) => boolean;
  spinners?: Map<string, { x: number; y: number }>;
}

const WATER_TILESETS = new Set([0, 3, 5, 7, 13, 14, 17, 22, 23]);

/** Builds a walkability grid for the CURRENT map from live WRAM + ROM tileset data. */
export function buildGrid(emu: Emulator, rom: Rom, gs: GameState): Grid {
  const m = emu.mem, r = rom.b;
  const W = gs.mapWidth, H = gs.mapHeight, tileset = gs.u8('wCurMapTileset');
  const bank = gs.u8('wTilesetBank');
  const blocksPtr = rom.flat(bank, m[sym('wTilesetBlocksPtr')] | (m[sym('wTilesetBlocksPtr') + 1] << 8));
  const collPtr = m[sym('wTilesetCollisionPtr')] | (m[sym('wTilesetCollisionPtr') + 1] << 8);
  const passable = new Set<number>();
  for (let a = rom.flat(bank, collPtr); r[a] !== 0xff; a++) passable.add(r[a]);
  const grassTile = gs.u8('wGrassTile');
  const tsHeader = sym('Tilesets') + tileset * 12;
  const counters = new Set([r[tsHeader + 7], r[tsHeader + 8], r[tsHeader + 9]].filter((t) => t !== 0xff));
  const ow = sym('wOverworldMap');

  const tile = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= W * 2 || y >= H * 2) return -1;
    const block = m[ow + ((y >> 1) + 3) * (W + 6) + (x >> 1) + 3];
    return r[blocksPtr + block * 16 + ((y & 1) * 2 + 1) * 4 + (x & 1) * 2];
  };

  // ledges: (facing, standing tile, ledge tile, input)
  const ledges: { dir: Dir; stand: number; ledge: number }[] = [];
  if (tileset === 0) {
    for (let a = sym('LedgeTiles'); r[a] !== 0xff; a += 4) ledges.push({ dir: FACING_TO_DIR[r[a]], stand: r[a + 1], ledge: r[a + 2] });
  }
  const pairs: [number, number][] = [];
  for (let a = sym('TilePairCollisionsLand'); r[a] !== 0xff; a += 3) if (r[a] === tileset) pairs.push([r[a + 1], r[a + 2]]);

  return {
    mapId: gs.mapId, w: W * 2, h: H * 2, tileset, tile,
    walkable: (x, y) => passable.has(tile(x, y)),
    grass: (x, y) => grassTile !== 0xff && tile(x, y) === grassTile,
    water: (x, y) => WATER_TILESETS.has(tileset) && tile(x, y) === 0x14,
    cuttable: (x, y) => (tileset === 0 && tile(x, y) === 0x3d) || (tileset === 7 && tile(x, y) === 0x50),
    counter: (x, y) => counters.has(tile(x, y)),
    ledge: (x, y, d) => {
      const [dx, dy] = DIRS[d];
      const s = tile(x, y), l = tile(x + dx, y + dy);
      return ledges.some((e) => e.dir === d && e.stand === s && e.ledge === l);
    },
    pairBlocked: (a, b) => pairs.some(([p, q]) => (p === a && q === b) || (p === b && q === a)),
    spinners: rom.spinners.get(gs.mapId),
  };
}

export interface Step { dir: Dir; x: number; y: number; jump?: boolean; spin?: boolean }

/**
 * A* over the grid. `blocked` = occupied squares (NPCs). Goal test is a predicate so callers
 * can path "next to" something or "off the map edge". Squares outside the map count as goals only
 * if `allowExit` says so.
 */
export function findPath(
  g: Grid, sx: number, sy: number,
  goal: (x: number, y: number) => boolean,
  opts: { blocked?: Set<string>; allowExit?: (x: number, y: number) => boolean; grassCost?: number; surf?: boolean; maxNodes?: number; spinners?: Map<string, { x: number; y: number }> } = {},
): Step[] | null {
  const key = (x: number, y: number) => `${x},${y}`;
  const spin_ = opts.spinners ?? g.spinners;
  const open: { x: number; y: number; f: number; g: number }[] = [{ x: sx, y: sy, f: 0, g: 0 }];
  const came = new Map<string, { from: string; step: Step }>();
  const cost = new Map<string, number>([[key(sx, sy), 0]]);
  let n = 0;
  while (open.length && n++ < (opts.maxNodes ?? 20000)) {
    let bi = 0;
    for (let i = 1; i < open.length; i++) if (open[i].f < open[bi].f) bi = i;
    const cur = open.splice(bi, 1)[0];
    if ((cur.x !== sx || cur.y !== sy) && goal(cur.x, cur.y)) {
      const path: Step[] = [];
      for (let k = key(cur.x, cur.y); came.has(k); k = came.get(k)!.from) path.unshift(came.get(k)!.step);
      return path;
    }
    const inside = cur.x >= 0 && cur.y >= 0 && cur.x < g.w && cur.y < g.h;
    if (!inside) continue; // exit squares are terminal
    for (const d of Object.keys(DIRS) as Dir[]) {
      const [dx, dy] = DIRS[d];
      let nx = cur.x + dx, ny = cur.y + dy, jump = false;
      const nk0 = key(nx, ny);
      const outside = nx < 0 || ny < 0 || nx >= g.w || ny >= g.h;
      if (outside) {
        if (!opts.allowExit?.(nx, ny)) continue;
      } else if (g.ledge(cur.x, cur.y, d)) {
        nx += dx; ny += dy; jump = true;
        if (!g.walkable(nx, ny)) continue;
      } else {
        const ok = g.walkable(nx, ny) || (opts.surf && g.water(nx, ny));
        if (!ok || opts.blocked?.has(nk0)) {
          if (!goal(nx, ny) || !g.walkable(nx, ny)) continue; // allow stepping onto goal only if walkable
          if (opts.blocked?.has(nk0)) continue;
        }
        if (g.pairBlocked(g.tile(cur.x, cur.y), g.tile(nx, ny))) continue;
      }
      // arrow tiles: stepping on one forces movement to its landing square (chains if it lands on another arrow)
      let spin = false, extra = 0;
      for (let hop = 0; hop < 8 && spin_?.has(`${nx},${ny}`); hop++) {
        const land = spin_.get(`${nx},${ny}`)!;
        extra += Math.abs(land.x - nx) + Math.abs(land.y - ny);
        nx = land.x; ny = land.y; spin = true;
      }
      if (spin && goal(nx, ny) === false && !g.walkable(nx, ny)) continue;
      const nk = key(nx, ny);
      const gc = cur.g + (jump ? 2 : 1) + extra + (!outside && g.grass(nx, ny) ? opts.grassCost ?? 0 : 0);
      if (gc < (cost.get(nk) ?? Infinity)) {
        cost.set(nk, gc);
        came.set(nk, { from: key(cur.x, cur.y), step: { dir: d, x: nx, y: ny, jump, spin } });
        open.push({ x: nx, y: ny, g: gc, f: gc });
      }
    }
  }
  return null;
}

/** World graph across maps (warps + connections) for "how many maps away" hints. */
export class WorldGraph {
  readonly edges = new Map<number, Set<number>>();
  constructor(rom: Rom) {
    const add = (a: number, b: number) => { if (!this.edges.has(a)) this.edges.set(a, new Set()); this.edges.get(a)!.add(b); };
    const into = new Map<number, number[]>();
    for (const md of rom.maps.values()) for (const w of md.warps) if (w.destMap !== 0xff) (into.get(w.destMap) ?? into.set(w.destMap, []).get(w.destMap)!).push(md.id);
    for (const md of rom.maps.values()) {
      for (const c of md.connections) add(md.id, c.map);
      for (const w of md.warps) {
        if (w.destMap !== 0xff) add(md.id, w.destMap);
        else for (const src of into.get(md.id) ?? []) add(md.id, src);
      }
    }
  }

  /** BFS hop distances from `from`. */
  distances(from: number): Map<number, number> {
    const d = new Map([[from, 0]]);
    const q = [from];
    while (q.length) {
      const c = q.shift()!;
      for (const n of this.edges.get(c) ?? []) if (!d.has(n)) { d.set(n, d.get(c)! + 1); q.push(n); }
    }
    return d;
  }

  hops(from: number, to: number[]): number {
    const d = this.distances(from);
    return Math.min(...to.map((t) => d.get(t) ?? Infinity));
  }
}

export { mapName };
