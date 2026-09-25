// Prints parsed spinner tiles (arrow start -> landing square) per map.
import fs from 'node:fs';
import { Rom } from '../../src/game/rom.js';
import { mapName } from '../../src/game/symbols.js';
const rom = new Rom(fs.readFileSync('roms/red.gb'));
for (const [m, t] of rom.spinners) console.log(mapName(m), t.size, [...t].slice(0, 6).map(([k, v]) => `${k}->${v.x},${v.y}`).join('  '));
