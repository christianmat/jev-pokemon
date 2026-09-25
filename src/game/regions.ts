import type { Rom, MapData } from './rom.js';
import { sym } from './symbols.js';

/**
 * Static region graph built from ROM map data: each map is split into walkable connected
 * components (ledges are one-way), linked by warps and map-edge connections. Used only to
 * annotate options with "N areas from the objective" — it never picks anything.
 * Cut trees / water / boulders count as blocked (they need an HM to pass).
 */
type Dir = 'up' | 'down' | 'left' | 'right';
const D: Record<Dir, [number, number]> = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
const FACING: Record<number, Dir> = { 0x0: 'down', 0x4: 'up', 0x8: 'left', 0xc: 'right' };

export interface StaticGrid { w: number; h: number; walk: (x: number, y: number) => boolean; tile: (x: number, y: number) => number; ledge: (x: number, y: number, d: Dir) => boolean; pairBlocked: (a: number, b: number) => boolean }

export interface Caps { cut: boolean; surf: boolean }
const WATER_TILESETS = new Set([0, 3, 5, 7, 13, 14, 17, 22, 23]);

export function staticGrid(rom: Rom, md: MapData, caps: Caps = { cut: false, surf: false }): StaticGrid {
  const r = rom.b;
  const ts = sym('Tilesets') + md.tileset * 12;
  const tsBank = r[ts];
  const blockset = rom.flat(tsBank, rom.u16(ts + 1));
  const coll = new Set<number>();
  for (let a = rom.u16(ts + 5); r[a] !== 0xff; a++) coll.add(r[a]);
  const blocks = rom.flat(md.bank, md.blocksPtr);
  const W = md.width, H = md.height;
  const tile = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= W * 2 || y >= H * 2) return -1;
    const b = r[blocks + (y >> 1) * W + (x >> 1)];
    return r[blockset + b * 16 + ((y & 1) * 2 + 1) * 4 + (x & 1) * 2];
  };
  // elevation tile pairs (caves/forest): can't step between these two tiles in either direction
  const pairs: [number, number][] = [];
  for (let a = sym('TilePairCollisionsLand'); r[a] !== 0xff; a += 3) if (r[a] === md.tileset) pairs.push([r[a + 1], r[a + 2]]);
  const ledges: { dir: Dir; stand: number; ledge: number }[] = [];
  if (md.tileset === 0) for (let a = sym('LedgeTiles'); r[a] !== 0xff; a += 4) ledges.push({ dir: FACING[r[a]], stand: r[a + 1], ledge: r[a + 2] });
  return {
    w: W * 2, h: H * 2, tile,
    walk: (x, y) => {
      const t = tile(x, y);
      if (coll.has(t)) return true;
      if (caps.cut && ((md.tileset === 0 && t === 0x3d) || (md.tileset === 7 && t === 0x50))) return true;
      if (caps.surf && WATER_TILESETS.has(md.tileset) && t === 0x14) return true;
      return false;
    },
    pairBlocked: (a, b) => pairs.some(([p, q]) => (p === a && q === b) || (p === b && q === a)),
    ledge: (x, y, d) => { const [dx, dy] = D[d]; const s = tile(x, y), l = tile(x + dx, y + dy); return ledges.some((e) => e.dir === d && e.stand === s && e.ledge === l); },
  };
}

export class RegionGraph {
  /** region id per map square: key `${map}` -> Int32Array (w*h), -1 = not walkable */
  private comp = new Map<number, { w: number; h: number; ids: Int32Array }>();
  private out = new Map<string, Set<string>>(); // region -> regions (directed)
  private grids = new Map<number, StaticGrid>();

  constructor(private rom: Rom, readonly caps: Caps = { cut: false, surf: false }) {
    for (const md of rom.maps.values()) this.label(md);
    for (const md of rom.maps.values()) this.link(md);
  }

  grid(map: number) { return this.grids.get(map); }

  private add(a: string, b: string) { if (a === b) return; (this.out.get(a) ?? this.out.set(a, new Set()).get(a)!).add(b); }

  /** Flood-fill undirected-ish components: ledge jumps add directed edges between components. */
  private label(md: MapData) {
    let g: StaticGrid;
    try { g = staticGrid(this.rom, md, this.caps); } catch { return; }
    this.grids.set(md.id, g);
    const ids = new Int32Array(g.w * g.h).fill(-1);
    let next = 0;
    const warpSq = new Set(md.warps.map((w) => `${w.x},${w.y}`));
    const spinners = this.rom.spinners.get(md.id);
    // arrow tiles are one-way conveyors: keep them out of the flood fill, link them as directed edges below
    const ok = (x: number, y: number) => x >= 0 && y >= 0 && x < g.w && y < g.h && !spinners?.has(`${x},${y}`) && (g.walk(x, y) || warpSq.has(`${x},${y}`));
    for (let y = 0; y < g.h; y++) for (let x = 0; x < g.w; x++) {
      if (ids[y * g.w + x] !== -1 || !ok(x, y)) continue;
      const q = [[x, y]]; ids[y * g.w + x] = next;
      while (q.length) {
        const [cx, cy] = q.pop()!;
        for (const d of Object.keys(D) as Dir[]) {
          const [dx, dy] = D[d]; const nx = cx + dx, ny = cy + dy;
          if (!ok(nx, ny) || ids[ny * g.w + nx] !== -1) continue;
          if (g.pairBlocked(g.tile(cx, cy), g.tile(nx, ny))) continue;
          // don't merge across ledges (handled as directed edges below)
          if (g.ledge(cx, cy, d) || g.ledge(nx, ny, (d === 'up' ? 'down' : d === 'down' ? 'up' : d === 'left' ? 'right' : 'left'))) continue;
          ids[ny * g.w + nx] = next; q.push([nx, ny]);
        }
      }
      next++;
    }
    this.comp.set(md.id, { w: g.w, h: g.h, ids });
    // spinners: from any region touching an arrow tile to the region where it lands (following chains)
    for (const [k, land0] of spinners ?? []) {
      const [sx, sy] = k.split(',').map(Number);
      let land = land0;
      for (let hop = 0; hop < 8 && spinners!.has(`${land.x},${land.y}`); hop++) land = spinners!.get(`${land.x},${land.y}`)!;
      const to = this.regionAt(md.id, land.x, land.y);
      for (const [dx, dy] of Object.values(D)) {
        const from = this.regionAt(md.id, sx + dx, sy + dy);
        if (from && to && ids[(sy + dy) * g.w + sx + dx] >= 0) this.add(from, to);
      }
    }
    // ledge jumps: directed edges
    for (let y = 0; y < g.h; y++) for (let x = 0; x < g.w; x++) for (const d of Object.keys(D) as Dir[]) {
      if (!g.ledge(x, y, d)) continue;
      const [dx, dy] = D[d];
      const a = this.regionAt(md.id, x, y), b = this.regionAt(md.id, x + 2 * dx, y + 2 * dy);
      if (a && b) this.add(a, b);
    }
  }

  regionAt(map: number, x: number, y: number): string | null {
    const c = this.comp.get(map);
    if (!c || x < 0 || y < 0 || x >= c.w || y >= c.h) return null;
    const id = c.ids[y * c.w + x];
    if (id >= 0) return `${map}:${id}`;
    // warp/door squares that aren't walkable: use an adjacent region
    for (const [dx, dy] of Object.values(D)) {
      const nx = x + dx, ny = y + dy;
      if (nx >= 0 && ny >= 0 && nx < c.w && ny < c.h && c.ids[ny * c.w + nx] >= 0) return `${map}:${c.ids[ny * c.w + nx]}`;
    }
    return null;
  }

  regionsOf(map: number): string[] {
    const c = this.comp.get(map);
    if (!c) return [];
    return [...new Set([...c.ids].filter((v) => v >= 0))].map((v) => `${map}:${v}`);
  }

  /** Where a warp in `md` actually lands (resolves LAST_MAP via reverse lookup). */
  warpTargets(md: MapData, wi: number): string[] {
    const w = md.warps[wi];
    const res: string[] = [];
    const land = (map: number, idx: number) => {
      const t = this.rom.maps.get(map)?.warps[idx];
      const r = t && this.regionAt(map, t.x, t.y);
      if (r) res.push(r);
    };
    if (w.destMap !== 0xff) land(w.destMap, w.destWarp);
    else for (const src of this.rom.maps.values()) src.warps.forEach((sw) => { if (sw.destMap === md.id && sw.destWarp === wi) land(src.id, w.destWarp); });
    return res;
  }

  /** Target region of stepping off the map edge at (x,y) in direction of connection. */
  connectionTarget(md: MapData, c: MapData['connections'][number], x: number, y: number): string | null {
    const nx = c.dir === 'north' || c.dir === 'south' ? x + c.xAlign : c.xAlign;
    const ny = c.dir === 'west' || c.dir === 'east' ? y + c.yAlign : c.yAlign;
    // the landing square itself must be walkable (regionAt also resolves blocked door squares to a neighbor)
    const comp = this.comp.get(c.map);
    if (!comp || nx < 0 || ny < 0 || nx >= comp.w || ny >= comp.h || comp.ids[ny * comp.w + nx] < 0) return null;
    return this.regionAt(c.map, nx, ny);
  }

  private link(md: MapData) {
    const g = this.grids.get(md.id);
    if (!g) return;
    md.warps.forEach((w, i) => {
      const a = this.regionAt(md.id, w.x, w.y);
      if (a) for (const b of this.warpTargets(md, i)) this.add(a, b);
    });
    for (const c of md.connections) {
      const edge: [number, number][] = [];
      if (c.dir === 'north') for (let x = 0; x < g.w; x++) edge.push([x, 0]);
      if (c.dir === 'south') for (let x = 0; x < g.w; x++) edge.push([x, g.h - 1]);
      if (c.dir === 'west') for (let y = 0; y < g.h; y++) edge.push([0, y]);
      if (c.dir === 'east') for (let y = 0; y < g.h; y++) edge.push([g.w - 1, y]);
      for (const [x, y] of edge) {
        if (!g.walk(x, y)) continue;
        const a = this.regionAt(md.id, x, y), b = this.connectionTarget(md, c, x, y);
        if (a && b) this.add(a, b);
      }
    }
  }

  /** Shortest number of region hops from each region TO any of `targets` (reverse BFS). */
  /** BFS hop counts to the targets; `skip` holds directed edges "a>b" known not to be passable right now. */
  distancesTo(targets: string[], skip?: Set<string>): Map<string, number> {
    const rev = new Map<string, string[]>();
    for (const [a, bs] of this.out) for (const b of bs) if (!skip?.has(`${a}>${b}`)) (rev.get(b) ?? rev.set(b, []).get(b)!).push(a);
    const d = new Map<string, number>(targets.map((t) => [t, 0]));
    const q = [...targets];
    while (q.length) {
      const c = q.shift()!;
      for (const p of rev.get(c) ?? []) if (!d.has(p)) { d.set(p, d.get(c)! + 1); q.push(p); }
    }
    return d;
  }
}
