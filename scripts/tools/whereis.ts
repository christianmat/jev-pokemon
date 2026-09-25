// Prints the map/position stored in each save state (debug helper).
import fs from 'node:fs';
import { Emulator } from '../../src/emu/emulator.js';
import { Rom } from '../../src/game/rom.js';
import { GameState } from '../../src/game/state.js';
const b = fs.readFileSync('roms/red.gb'); const e = new Emulator(b); const g = new GameState(e, new Rom(b));
for (const f of fs.readdirSync('saves').filter((f) => f.endsWith('.state.json')).sort()) { e.loadState(`saves/${f}`); console.log(f, g.mapName, g.x, g.y); }
