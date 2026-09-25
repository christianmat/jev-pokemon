import { RegionGraph } from '../src/game/regions.js';
// Debug: run the agent from a save and print per-step mode/position/player sprite state.
import fs from 'node:fs';
import { Emulator } from '../src/emu/emulator.js';
import { Rom } from '../src/game/rom.js';
import { GameState } from '../src/game/state.js';
import { Jev } from '../src/jev/client.js';
import { Agent } from '../src/agent/agent.js';
import { newMemory, type Ctx } from '../src/agent/context.js';

const [name = 'milestone-01-meet_oak', stepsArg = '120'] = process.argv.slice(2);
const romBuf = fs.readFileSync('roms/red.gb');
const emu = new Emulator(romBuf), rom = new Rom(romBuf), gs = new GameState(emu, rom);
const ctx: Ctx = { emu, rom, gs, jev: new Jev({ logFile: '/dev/null', minIntervalMs: 0 }), regions: new RegionGraph(rom), mem: newMemory(), log: (k, m) => console.log(`   [${k}] ${m}`) };
const agent = new Agent(ctx);
agent.load(name);
const hex = (a: number, n: number) => Array.from(emu.mem.slice(a, a + n)).map((v) => v.toString(16).padStart(2, '0')).join(' ');
for (let i = 0; i < +stepsArg; i++) {
  const mode = agent.mode();
  const f0 = emu.frames;
  await agent.step();
  console.log(i, mode, gs.mapName, gs.x, gs.y, 'frames+', emu.frames - f0, 'c100', hex(0xc100, 4), 'd730', emu.mem[0xd730].toString(16), JSON.stringify(gs.screen().dialog).slice(0, 40));
}
agent.save('trace-end');
