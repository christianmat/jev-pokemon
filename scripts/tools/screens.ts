// Debug: load a save, run a button script, dump the screen after each step.
// usage: tsx scripts/dbg/screens.ts <save> "START,w20,A,..."  (wN = wait N frames, hBTN:N = hold)
import fs from 'node:fs';
import { Emulator } from '../../src/emu/emulator.js';
import { Rom } from '../../src/game/rom.js';
import { GameState } from '../../src/game/state.js';
import { toPng } from '../../src/emu/png.js';
const romBuf = fs.readFileSync('roms/red.gb');
const emu = new Emulator(romBuf), rom = new Rom(romBuf), gs = new GameState(emu, rom);
emu.loadState(`saves/${process.argv[2]}.state.json`);
emu.wait(10);
for (const b of (process.argv[3] ?? '').split(',').filter(Boolean)) {
  if (b.startsWith('w')) emu.wait(+b.slice(1));
  else if (b.startsWith('h')) { const [bb, n] = b.slice(1).split(':'); emu.hold(bb as any, +n); }
  else emu.press(b as any, 4, 20);
}
const s = gs.screen();
console.log(s.rows.map((r, i) => String(i).padStart(2) + '|' + r).join('\n'));
console.log({ map: gs.mapName, x: gs.x, y: gs.y, cursor: s.cursor, menu: gs.menu() });
fs.writeFileSync('logs/screen.png', toPng(emu.screen()));
