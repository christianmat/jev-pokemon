import fs from 'node:fs';
import { Rom } from '../../src/game/rom.js';
import { RegionGraph } from '../../src/game/regions.js';
import { MAPS, mapName } from '../../src/game/symbols.js';
const rom = new Rom(fs.readFileSync('roms/red.gb'));
const rg = new RegionGraph(rom);
const id = (n: string) => +Object.entries(MAPS).find(([, v]) => v.name === n)![0];
const d = rg.distancesTo(rg.regionsOf(id('CERULEAN_CITY')));
for (const m of ['MT_MOON_1F', 'MT_MOON_B1F', 'MT_MOON_B2F', 'ROUTE_4']) {
  const md = rom.maps.get(id(m))!;
  md.warps.forEach((w, i) => {
    const here = rg.regionAt(md.id, w.x, w.y);
    const tg = rg.warpTargets(md, i);
    console.log(`${m} warp${i} (${w.x},${w.y}) region ${here} d=${here ? d.get(here) : '-'} -> ${tg.map((t) => `${mapName(+t.split(':')[0])}:${t.split(':')[1]} d=${d.get(t)}`).join(',')}`);
  });
}
