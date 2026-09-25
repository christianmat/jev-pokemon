import type { Emulator, Button } from '../emu/emulator.js';
import type { Rom } from '../game/rom.js';
import type { GameState } from '../game/state.js';
import type { Jev } from '../jev/client.js';
import { RegionGraph, type Caps } from '../game/regions.js';
import { currentMilestone } from '../knowledge/milestones.js';
import { mapName } from '../game/symbols.js';

export interface Memory {
  visitedMaps: Record<string, number>;
  talked: Record<string, number>;       // "MAP:npcIndex" -> count
  usedTargets: Record<string, number>;  // "MAP:targetKey" -> count
  dialog: string[];                     // recent dialog lines
  actions: string[];                    // recent decisions (human readable)
  stepsInMap: Record<string, Set<string>>;
  npcText: Record<string, string>;      // what an NPC/sign said last time
  lastInteraction: string | null;
  currentTalk?: string[]; // lines spoken since the current interaction started
  intent: { value: string; key: string; age?: number } | null;
  triedNoProgress: Record<string, number>;
  blockedExits: Record<string, number>;
  /** region edges "a>b" where an exit stopped us (a guard, a script): count of failed attempts */
  blockedEdges?: Record<string, number>;
  /** a shop counter was left since the 'shop' focus was chosen */
  shopDone?: boolean;
  bestHops: Record<number, number>; // milestone index -> closest region distance to its objective reached so far // 'MAP:option' -> times it didn't get through // action -> times chosen since the last real progress // cached overworld intent + the situation it was chosen in
}

export interface Ctx {
  emu: Emulator; rom: Rom; gs: GameState; jev: Jev; regions: RegionGraph; mem: Memory;
  log: (kind: string, msg: string, data?: unknown) => void;
}

export function newMemory(): Memory {
  return { visitedMaps: {}, talked: {}, usedTargets: {}, dialog: [], actions: [], stepsInMap: {}, npcText: {}, lastInteraction: null, intent: null, triedNoProgress: {}, blockedExits: {}, bestHops: {} };
}

/** Record dialog as whole lines: strip prompts, merge text that is still being typed out. */
export function rememberDialog(mem: Memory, raw: string) {
  const line = raw.replace(/[▼▶▷]/g, '').replace(/\s+/g, ' ').trim();
  if (!line) return;
  const d = mem.dialog;
  const last = d[d.length - 1];
  if (last && (last.startsWith(line) || last.endsWith(line))) return;      // already have it
  if (last && line.startsWith(last)) { d[d.length - 1] = line; return; }   // same line, more typed
  // text box scrolled: new line begins with the tail of the previous one
  if (last) {
    const words = last.split(' ');
    for (let k = Math.min(words.length, 6); k >= 2; k--) {
      const tail = words.slice(-k).join(' ');
      if (line.startsWith(tail)) { d[d.length - 1] = `${last} ${line.slice(tail.length).trim()}`.trim(); return; }
    }
  }
  d.push(line);
  while (d.length > 12) d.shift();
}

export function remember<T>(arr: T[], v: T, max: number) {
  if (arr[arr.length - 1] === v) return;
  arr.push(v);
  while (arr.length > max) arr.shift();
}

/** Tap a button and let the game react. */
export function tap(ctx: Ctx, b: Button, settle = 10) {
  ctx.emu.press(b, 6, settle);
}

/** Compact, Jev-facing summary of the player situation (shared across decision types). */
export function situation(ctx: Ctx) {
  const { gs } = ctx;
  const { m } = currentMilestone(gs);
  const party = gs.party();
  const hp = party.reduce((a, p) => a + p.hp, 0), maxHp = party.reduce((a, p) => a + p.maxHp, 0);
  return {
    objective: m ? { goal: m.goal, where: m.maps.join(' / '), typicalOpponentLevel: m.level } : 'Game complete',
    partyHealth: maxHp ? `${Math.round((100 * hp) / maxHp)}% total HP, ${party.filter((p) => p.hp === 0).length} fainted` : 'no Pokémon',
    strongestLevel: Math.max(0, ...party.map((p) => p.level)),
    teamSize: `${party.length}/6`,
    // type-chart facts: how each team member matches up against the objective's opponents
    teamVsObjective: m?.types ? party.map((p) => {
      const eff = (t: string) => Math.max(0, ...p.moves.filter((mv) => mv.power > 0).map((mv) => ctx.rom.effectiveness(mv.type, [t])));
      const best = Math.max(...m.types!.map(eff));
      const threat = Math.max(...m.types!.map((t) => ctx.rom.effectiveness(t, p.types)));
      const word = (x: number) => (x === 0 ? 'no effect' : x >= 2 ? `super effective x${x}` : x < 1 ? `not very effective x${x}` : 'normal effectiveness');
      const attacks = p.moves.some((mv) => mv.power > 0) ? `best move vs ${m.types!.join('/')} is ${word(best)}` : 'has no damaging moves';
      return `${p.species} Lv${p.level}: ${attacks}; ${m.types!.join('/')} moves are ${word(threat)} against it`;
    }) : undefined,
    // where the player reappears if every Pokémon faints (the last Pokémon Center used); losing also halves money
    returnPointIfAllFaint: `Pokémon Center in ${mapName(gs.u8('wLastBlackoutMap'))}`,
    pokeBalls: gs.bag().filter((i) => /BALL$/.test(i.name)).reduce((a, i) => a + i.qty, 0),
    location: gs.mapName,
    badges: gs.badgeCount,
    money: gs.money,
    party: gs.party().map((p) => ({
      name: p.nickname, species: p.species, level: p.level, hp: `${p.hp}/${p.maxHp}`, status: p.status, types: p.types.join('/'),
      moves: p.moves.map((mv) => `${mv.name} (${mv.type}, pow ${mv.power}, ${mv.pp}/${mv.maxPp}pp)`),
    })),
    bag: gs.bag().map((i) => `${i.name} x${i.qty}`),
    recentDialog: ctx.mem.dialog.slice(-6),
    recentActions: ctx.mem.actions.slice(-6),
  };
}

/** Field-move capabilities from real game state (HM in a party move list + required badge). */
export function capabilities(ctx: Ctx): Caps {
  const moves = new Set(ctx.gs.party().flatMap((p) => p.moves.map((m) => m.name)));
  return { cut: moves.has('CUT') && !!(ctx.gs.badges & 0x02), surf: moves.has('SURF') && !!(ctx.gs.badges & 0x10) };
}

/** Region graph matching current capabilities (rebuilt when Cut/Surf become available). */
export function regionGraph(ctx: Ctx): RegionGraph {
  const c = capabilities(ctx);
  if (c.cut !== ctx.regions.caps.cut || c.surf !== ctx.regions.caps.surf) ctx.regions = new RegionGraph(ctx.rom, c);
  return ctx.regions;
}
