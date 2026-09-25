import fs from 'node:fs';
import { Rom } from '../../src/game/rom.js';
import { staticGrid } from '../../src/game/regions.js';
import { MAPS } from '../../src/game/symbols.js';
import gen from '../../src/data/generated.json' with { type: 'json' };
const rom = new Rom(fs.readFileSync('roms/red.gb'));
const md = rom.maps.get(+Object.entries(MAPS).find(([, v]) => v.name === 'MT_MOON_B2F')![0])!;
const g = staticGrid(rom, md);
const people = md.objects.map((o) => ({ x: o.x, y: o.y, name: (gen as any).sprites[o.sprite] }));
const blocked = new Set(people.map((p) => `${p.x},${p.y}`));
const warps = new Set(md.warps.map((w) => `${w.x},${w.y}`));
function bfs(sx: number, sy: number, tx: number, ty: number, useSprites: boolean) {
  const prev = new Map<string, string>(); const q = [[sx, sy]]; prev.set(`${sx},${sy}`, '');
  while (q.length) { const [x, y] = q.shift()!; if (x === tx && y === ty) { const path = []; for (let k = `${x},${y}`; k; k = prev.get(k)!) path.unshift(k); return path; }
    for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) { const nx = x+dx, ny = y+dy, k = `${nx},${ny}`; if (prev.has(k)) continue;
      const isT = nx === tx && ny === ty; if (!isT && (!g.walk(nx, ny) || warps.has(k) || (useSprites && blocked.has(k)))) continue; if (g.pairBlocked(g.tile(x,y), g.tile(nx,ny))) continue; prev.set(k, `${x},${y}`); q.push([nx, ny]); } }
  return null;
}
const a = bfs(22, 17, 5, 7, true), b = bfs(22, 17, 5, 7, false);
console.log('with people:', a ? a.length : 'NO PATH', '| without:', b ? b.length : 'NO PATH');
if (b) console.log('people on the free path:', b.filter((k) => blocked.has(k)).map((k) => `${people.find((p) => `${p.x},${p.y}` === k)!.name}@${k}`));
for (const p of people) {
  const saved = new Set(blocked); blocked.delete(`${p.x},${p.y}`);
  const r = bfs(22, 17, 5, 7, true); if (r) console.log('removing only', p.name, `(${p.x},${p.y})`, 'opens the way');
  blocked.clear(); saved.forEach((k) => blocked.add(k));
}
