import { RegionGraph } from '../src/game/regions.js';
// Debug: load a save state and print what the agent sees.
import fs from 'node:fs';
import { Emulator } from '../src/emu/emulator.js';
import { Rom } from '../src/game/rom.js';
import { GameState } from '../src/game/state.js';
import { buildGrid } from '../src/game/world.js';
import { Jev } from '../src/jev/client.js';
import { Agent } from '../src/agent/agent.js';
import { newMemory, type Ctx } from '../src/agent/context.js';

const name = process.argv[2] ?? 'headless-end';
const romBuf = fs.readFileSync('roms/red.gb');
const emu = new Emulator(romBuf), rom = new Rom(romBuf), gs = new GameState(emu, rom);
const ctx: Ctx = { emu, rom, gs, jev: new Jev({ logFile: '/dev/null' }), regions: new RegionGraph(rom), mem: newMemory(), log: (k, m) => console.log(`[${k}] ${m}`) };
const agent = new Agent(ctx);
agent.load(name);
emu.wait(+(process.argv[3] ?? 1));
const s = gs.screen();
console.log(s.rows.map((r, i) => String(i).padStart(2) + '|' + r).join('\n'));
console.log({ mode: agent.mode(), map: gs.mapName, x: gs.x, y: gs.y, cursor: s.cursor, waitingForA: s.waitingForA, menu: gs.menu(), c100: emu.mem[0xc100], w: gs.mapWidth, h: gs.mapHeight, joyIgnore: gs.joyIgnore });
if (agent.mode() === 'overworld') {
  const g = buildGrid(emu, rom, gs);
  const spr = new Set(gs.sprites().filter((s) => !s.hidden).map((s) => `${s.x},${s.y}`));
  for (let y = 0; y < g.h; y++) {
    let line = '';
    for (let x = 0; x < g.w; x++) line += x === gs.x && y === gs.y ? '@' : spr.has(`${x},${y}`) ? 'N' : g.grass(x, y) ? '"' : g.walkable(x, y) ? '.' : g.water(x, y) ? '~' : '#';
    console.log(line);
  }
  console.log(gs.sprites(), rom.maps.get(gs.mapId)?.warps);
}
import { toPng } from '../src/emu/png.js';
fs.writeFileSync(`logs/${name}.png`, toPng(emu.screen()));
console.log(`screenshot: logs/${name}.png`);
