// Generates src/data/generated.json from the pret/pokered disassembly (vendor/pokered).
// Only names/constants/addresses — no gameplay logic.
import fs from 'node:fs';
import path from 'node:path';

const P = path.resolve('vendor/pokered');
const read = (f: string) => fs.readFileSync(path.join(P, f), 'utf8');

// map ids -> names
const maps: Record<number, { name: string; width: number; height: number }> = {};
{
  let id = 0;
  for (const line of read('constants/map_constants.asm').split('\n')) {
    const m = line.match(/^\s*map_const\s+(\w+),\s*(\d+),\s*(\d+)/);
    if (m) { maps[id] = { name: m[1], width: +m[2], height: +m[3] }; id++; }
    else if (/^\s*const_def/.test(line)) id = 0;
    else if (/^\s*const_next\s+\$?(\w+)/.test(line)) { /* not used in map consts */ }
  }
}

// event flags
const events: Record<string, number> = {};
{
  let v = 0;
  for (const line of read('constants/event_constants.asm').split('\n')) {
    let m;
    if (/^\s*const_def/.test(line)) v = 0;
    else if ((m = line.match(/^\s*const_skip\s*(\d+)?/))) v += m[1] ? +m[1] : 1;
    else if ((m = line.match(/^\s*const_next\s+\$([0-9a-fA-F]+)/))) v = parseInt(m[1], 16);
    else if ((m = line.match(/^\s*const_next\s+(\d+)/))) v = +m[1];
    else if ((m = line.match(/^\s*const\s+(EVENT_\w+)/))) { events[m[1]] = v; v++; }
  }
}

// sprite ids
const sprites: Record<number, string> = {};
{
  let v = 0;
  for (const line of read('constants/sprite_constants.asm').split('\n')) {
    let m;
    if (/^\s*const_def\s*(\d+)?/.test(line)) { m = line.match(/const_def\s*(\d+)/); v = m ? +m[1] : 0; }
    else if ((m = line.match(/^\s*const\s+SPRITE_(\w+)/))) { sprites[v] = m[1]; v++; }
  }
}

// charmap (english font range)
const charmap: Record<number, string> = {};
for (const line of read('constants/charmap.asm').split('\n')) {
  const m = line.match(/^\s*charmap\s+"(.+?)",\s*\$([0-9a-fA-F]{2})/);
  if (!m) continue;
  const code = parseInt(m[2], 16);
  if (code < 0x79 && code !== 0x4a && code !== 0x54) continue;
  if (code === 0x7f) { charmap[code] = ' '; continue; }
  if (charmap[code] === undefined) charmap[code] = m[1].replace('<PK>', 'PK').replace('<MN>', 'MN').replace('<PKMN>', 'PKMN');
}
charmap[0x54] = 'POKé';
charmap[0xed] = '▶';

// symbols we care about (all WRAM/HRAM + ROM tables)
const sym: Record<string, number> = {};
for (const line of read('pokered.sym').split('\n')) {
  const m = line.match(/^([0-9a-f]{2}):([0-9a-f]{4}) (\S+)$/);
  if (!m) continue;
  const bank = parseInt(m[1], 16), addr = parseInt(m[2], 16), name = m[3];
  if (/^[wh][A-Z]/.test(name) || /^[A-Z]\w+$/.test(name)) {
    sym[name] = addr >= 0x4000 && addr < 0x8000 ? bank * 0x4000 + (addr - 0x4000) : addr;
  }
}

fs.writeFileSync('src/data/generated.json', JSON.stringify({ maps, events, charmap, sprites, sym }));
console.log(`maps=${Object.keys(maps).length} events=${Object.keys(events).length} chars=${Object.keys(charmap).length} syms=${Object.keys(sym).length}`);
