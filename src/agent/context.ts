import type { Emulator, Button } from '../emu/emulator.js';
import type { Rom } from '../game/rom.js';
import type { GameState } from '../game/state.js';
import type { Jev } from '../jev/client.js';
import { RegionGraph, type Caps } from '../game/regions.js';
import { currentMilestone, missingNeed } from '../knowledge/milestones.js';
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
  /** the PC was logged off since the 'team' focus was chosen */
  pcDone?: boolean;
  /** team+box signature when the PC was last left: the 'team' focus isn't offered again until it changes */
  teamSig?: string;
  /** money when the last shop visit ended: 'shop' is offered again once there's ¥200+ more */
  shopMoney?: number;
  /** milestone whose prerequisite item was missing at the last check */
  needsMissing?: string;
  /** when the last shop focus ended (ms since epoch) */
  shopAt?: number;
  /** when the last team focus ended (ms since epoch) */
  teamAt?: number;
  /** badges|milestone|bag when blockedExits was last valid */
  blockSig?: string;
  /** a field move no party Pokémon knows that the way to the objective needs (set by the overworld) */
  fieldMoveNeeded?: 'CUT' | 'SURF';
  /** a first step the objective needs before its own location can be reached (set by the overworld) */
  subObjective?: string;
  /** since when (ms) the current field-move first step has been unmet */
  subSince?: number;
  /** route facts come from the map layout because a gate is closed right now */
  gatedRoute?: boolean;
  /** whole-team losses by map: how many, and the team (species + levels) at the last one */
  losses?: Record<string, { count: number; team: string; moves?: string }>;
  /** last BILL's PC mode chosen (WITHDRAW/DEPOSIT/RELEASE), for list facts */
  pcMode?: string;
  /** last bag item chosen (for TM/HM party-menu facts) */
  lastItem?: string;
  /** bag items opened from the overworld and closed without effect: count (hidden after 3) */
  itemUnused?: Record<string, number>;
  /** an open PC session: menu choices since the last change to team/box/bag */
  pcSession?: { steps: number; sig: string };
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
    fieldMoveNeeded: ctx.mem.fieldMoveNeeded ? fieldMoveFact(ctx, ctx.mem.fieldMoveNeeded) : undefined,
    objective: m ? { goal: m.goal, where: ctx.mem.subObjective ? `First: ${ctx.mem.subObjective}; then ${m.maps.join(' / ')}` : missingNeed(m, gs) ? `${missingNeed(m, gs)!.maps.join(' / ')} first (you don't have ${missingNeed(m, gs)!.what} yet), then ${m.maps.join(' / ')}` : m.maps.join(' / '), typicalOpponentLevel: m.level } : 'Game complete',
    partyHealth: maxHp ? `${Math.round((100 * hp) / maxHp)}% total HP, ${party.filter((p) => p.hp === 0).length} fainted` : 'no Pokémon',
    strongestLevel: Math.max(0, ...party.map((p) => p.level)),
    teamSize: `${party.length}/6`,
    // type-chart facts: how each team member matches up against the objective's opponents
    teamVsObjective: m?.types ? party.map((p) => {
      const eff = (ts: string[]) => Math.max(0, ...p.moves.filter((mv) => mv.power > 0).map((mv) => ctx.rom.effectiveness(mv.type, ts)));
      const best = m.dualType ? eff(m.types!) : Math.max(...m.types!.map((t) => eff([t])));
      const threat = Math.max(...m.types!.map((t) => ctx.rom.effectiveness(t, p.types)));
      const word = (x: number) => (x === 0 ? 'no effect' : x >= 2 ? `super effective x${x}` : x < 1 ? `not very effective x${x}` : 'normal effectiveness');
      const attacks = p.moves.some((mv) => mv.power > 0) ? `best move vs ${m.types!.join('/')} is ${word(best)}` : 'has no damaging moves';
      return `${p.species} Lv${p.level}: ${attacks}; ${m.types!.join('/')} moves are ${word(threat)} against it`;
    }) : undefined,
    // where the player reappears if every Pokémon faints (the last Pokémon Center used); losing also halves money
    returnPointIfAllFaint: `Pokémon Center in ${mapName(gs.u8('wLastBlackoutMap'))}`,
    lossesSoFar: Object.keys(ctx.mem.losses ?? {}).length ? Object.entries(ctx.mem.losses!).map(([m, l]) => `All Pokémon fainted at ${m} ${l.count} time(s); team at the last one: ${l.team}`) : undefined,
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

/** Information about under-leveled team members (Jev decides what to do with it). */
export function weakTeamNote(ctx: Ctx): string | undefined {
  const { m } = currentMilestone(ctx.gs);
  const party = ctx.gs.party();
  if (!m?.level || !party.length) return undefined;
  const weak = party.filter((p) => p.level <= m.level! - 10);
  if (!weak.length) return undefined;
  return `${weak.length} of your ${party.length} Pokémon are 10+ levels below the typical opponent level of the objective (Lv${m.level}): ${weak.map((p) => `${p.nickname} Lv${p.level}`).join(', ')}. Wild Pokémon at higher levels can be caught and swapped in at a Pokémon Center PC to make the team stronger.`;
}

const HM_FOR = { CUT: { hm: 'HM01', badge: 0x02, badgeName: 'Cascade Badge' }, SURF: { hm: 'HM03', badge: 0x10, badgeName: 'Soul Badge' } } as const;
/** Which party / PC box Pokémon can learn the HM for a field move (from the ROM's compatibility table). */
export function fieldMoveLearners(ctx: Ctx, mv: 'CUT' | 'SURF') {
  const hmId = [...ctx.rom.items.entries()].find(([, n]) => n === HM_FOR[mv].hm)?.[0];
  const can = (speciesId: number) => hmId !== undefined && ctx.rom.canLearnMachine(speciesId, hmId);
  // not yet, but after evolving (by level or with an item; trades aren't possible here)
  const bag = new Set(ctx.gs.bag().map((i) => i.name));
  const viaEvo = (speciesId: number, level?: number): string | undefined => {
    for (const e of ctx.rom.evolutions(speciesId)) {
      if (e.method === 'trade') continue;
      const into = ctx.rom.species.get(e.into)?.name ?? '?';
      // level evolutions happen on a level-up: already past the level means its next level-up
      const how = e.method === 'level' ? (level !== undefined && level >= e.level! ? `on its next level-up (it's past Lv${e.level})` : `at Lv${e.level}`) : `with a ${ctx.rom.items.get(e.item!) ?? 'item'} (${bag.has(ctx.rom.items.get(e.item!) ?? '') ? 'one is in the bag' : 'none in the bag'})`;
      if (can(e.into)) return `evolves into ${into} ${how}, which can learn it`;
      const next = viaEvo(e.into, e.method === 'level' ? Math.max(level ?? 0, e.level!) : level);
      if (next) return `evolves into ${into} ${how}, then ${next}`;
    }
    return undefined;
  };
  const later = (list: { speciesId: number; nickname: string; species: string; level: number }[]) =>
    list.filter((p) => !can(p.speciesId)).map((p) => { const v = viaEvo(p.speciesId, p.level); return v ? `${p.nickname} (${p.species} Lv${p.level}) ${v}` : ''; }).filter(Boolean);
  const party = ctx.gs.party(), box = ctx.gs.box();
  // what each way takes: levels to gain, items to use, PC moves, then teaching the HM (plain counts, no ranking)
  const chain = (speciesId: number, depth = 0): { level?: number; item?: string }[] | undefined => {
    if (can(speciesId)) return [];
    if (depth > 2) return undefined;
    for (const e of ctx.rom.evolutions(speciesId)) {
      if (e.method === 'trade') continue;
      const rest = chain(e.into, depth + 1);
      if (rest) return [e.method === 'level' ? { level: e.level } : { item: ctx.rom.items.get(e.item!) ?? '?' }, ...rest];
    }
    return undefined;
  };
  const routes: string[] = [];
  const costs: { inBox: boolean; cost: number }[] = []; // levels + actions, for the stalled-prerequisite rule
  const describe = (m: { speciesId: number; nickname: string; species: string; level: number }, inBox: boolean) => {
    const c = chain(m.speciesId);
    if (!c) return;
    // level evolutions happen on a level-up: one past its evolution level still needs one more level
    const lvSteps = c.filter((x) => x.level !== undefined).map((x) => x.level!);
    const lv = lvSteps.length ? Math.max(m.level + 1, ...lvSteps) : m.level;
    const levels = lv - m.level;
    const items = c.filter((x) => x.item).map((x) => x.item!);
    if (items.some((i) => !bag.has(i))) return; // an item that isn't in the bag: not a way right now
    const parts = [
      ...(inBox ? [party.length >= 6 ? 'at a Pokémon Center PC: deposit one team member and withdraw it' : 'at a Pokémon Center PC: withdraw it'] : []),
      ...(levels > 0 ? [`gain ${levels} level(s) (Lv${m.level} → Lv${lv})`] : []),
      ...items.map((i) => `use the ${i}`),
      `teach ${HM_FOR[mv].hm}`,
    ];
    routes.push(`${m.nickname} (${m.species}, ${inBox ? 'PC box' : 'team'}): ${parts.join(', then ')}`);
    costs.push({ inBox, cost: levels + parts.length - (levels > 0 ? 1 : 0) + (inBox && party.length >= 6 ? 1 : 0) });
  };
  for (const m of party) describe(m, false);
  for (const m of box) describe(m, true);
  return {
    party: party.filter((p) => can(p.speciesId)).map((p) => `${p.nickname} (${p.species} Lv${p.level})`),
    box: box.filter((b) => can(b.speciesId)).map((b) => `${b.nickname} (${b.species} Lv${b.level})`),
    afterEvolving: [...later(party).map((t) => `in the party: ${t}`), ...later(box).map((t) => `in the PC box: ${t}`)],
    routes,
    costs,
  };
}
function fieldMoveFact(ctx: Ctx, mv: 'CUT' | 'SURF') {
  const h = HM_FOR[mv];
  const l = fieldMoveLearners(ctx, mv);
  const inBag = ctx.gs.bag().some((i) => i.name === h.hm);
  return `The objective can't be reached from here without ${mv}, and no party Pokémon knows ${mv}. ${h.hm} teaches ${mv} (${inBag ? 'it is in the bag; HMs can be used any number of times' : 'not in the bag'}); using ${mv} outside battle needs the ${h.badgeName}${ctx.gs.badges & h.badge ? ' (you have it)' : ' (you don\'t have it yet)'}. Party Pokémon that can learn ${h.hm}: ${l.party.join(', ') || 'none'}. Pokémon in the PC box that can learn it: ${l.box.join(', ') || 'none'}.${l.afterEvolving.length ? ` Able to learn it only after evolving: ${l.afterEvolving.join('; ')}.` : ''}${l.routes.length ? ` What each way takes: ${l.routes.join('; ')}.` : ''}`;
}
