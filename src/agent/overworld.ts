import type { Ctx } from './context.js';
import { tap, situation, regionGraph } from './context.js';
import type { Agent } from './agent.js';
import { buildGrid, findPath, DIRS, type Dir, type Grid, type Step } from '../game/world.js';
import { sym, mapName } from '../game/symbols.js';
import gen from '../data/generated.json' with { type: 'json' };
import { currentMilestone } from '../knowledge/milestones.js';
import { useFieldMove, useItem, slotWithMove, closeMenus } from './field.js';
import { capabilities } from './context.js';

const SPRITES = (gen as any).sprites as Record<string, string>;
const loggedUnreachable = new Set<string>();

type Target =
  | { kind: 'warp'; x: number; y: number; dest: number }
  | { kind: 'hidden'; x: number; y: number; face: number | null }
  | { kind: 'cut'; x: number; y: number }
  | { kind: 'surf'; x: number; y: number }
  | { kind: 'strength' }
  | { kind: 'push'; x: number; y: number; dir: Dir }
  | { kind: 'item'; name: string }
  | { kind: 'exit'; dir: Dir; dest: number }
  | { kind: 'npc'; index: number; x: number; y: number; sprite: string }
  | { kind: 'sign'; x: number; y: number }
  | { kind: 'grass' }
  | { kind: 'explore' };

interface Candidate { key: string; desc: string; target: Target; path: Step[] }
/** destination regions of the exit candidates built last (for learning blocked edges) */
const destRegionsByKey = new Map<string, string[]>();

const adj = (x: number, y: number, tx: number, ty: number) => Math.abs(x - tx) + Math.abs(y - ty) === 1;

function blockedSquares(ctx: Ctx, exceptIndex = -1): Set<string> {
  const s = new Set<string>();
  for (const sp of ctx.gs.sprites()) if (!sp.hidden && sp.index !== exceptIndex) s.add(`${sp.x},${sp.y}`);
  return s;
}

/** Squares from which the player can interact with (tx,ty): adjacent, or across a counter. */
function interactGoal(g: Grid, tx: number, ty: number) {
  return (x: number, y: number) => {
    if (adj(x, y, tx, ty)) return true;
    for (const [dx, dy] of Object.values(DIRS)) if (x + 2 * dx === tx && y + 2 * dy === ty && g.counter(x + dx, y + dy)) return true;
    return false;
  };
}

/** Long speech: keep the opening and the end (where requests/instructions usually are). */
function clip(t: string): string {
  return t.length <= 420 ? t : `${t.slice(0, 120)} … ${t.slice(-290)}`;
}

export function buildCandidates(ctx: Ctx): Candidate[] {
  const { gs, rom, mem } = ctx;
  const rg = regionGraph(ctx);
  const g = buildGrid(ctx.emu, rom, gs);
  const md = rom.maps.get(gs.mapId);
  const px = gs.x, py = gs.y;
  // NPCs block, and so do warp tiles (doors/ladders): stepping on one mid-path would warp us away by accident
  const warpSquares = new Set((md?.warps ?? []).map((w) => `${w.x},${w.y}`));
  const blocked = new Set([...blockedSquares(ctx), ...warpSquares]);
  const surf = gs.walkState === 2;
  const { m } = currentMilestone(gs);
  const objMaps = (m?.maps ?? []).map((n) => Object.entries((gen as any).maps).find(([, v]: any) => v.name === n)?.[0]).filter(Boolean).map(Number);
  // exits that stopped us at least twice are left out of route distances until one works again
  const skip = new Set(Object.entries(mem.blockedEdges ?? {}).filter(([, n]) => n >= 2).map(([e]) => e));
  // the objective's area: a specific spot when the milestone gives one (a map can have unconnected parts)
  const atMap = m?.at ? objMaps.find((id) => mapName(id) === m.at!.map) : undefined;
  const atRegion = atMap !== undefined ? rg.regionAt(atMap, m!.at!.x, m!.at!.y) : null;
  const objRegions = atRegion ? [atRegion] : objMaps.flatMap((id) => rg.regionsOf(id));
  const inObjective = (map: number, regions: (string | null)[]) => (atRegion ? regions.includes(atRegion) : objMaps.includes(map));
  const dist = rg.distancesTo(objRegions, skip);
  destRegionsByKey.clear();
  const hereRegion = rg.regionAt(gs.mapId, px, py);
  const hereHops = inObjective(gs.mapId, [hereRegion]) ? 0 : (hereRegion ? dist.get(hereRegion) : undefined) ?? Infinity;
  // Getting closer to the objective counts as progress (mazes need back-and-forth without new maps)
  const mi = currentMilestone(gs).index;
  if (isFinite(hereHops) && hereHops < (mem.bestHops[mi] ?? Infinity)) mem.bestHops[mi] = hereHops;
  // progress = closer than at any point in the recent past (a B1F↔B2F cycle doesn't count as progress each time)
  if (isFinite(hereHops)) {
    const recentBest = Math.min(Infinity, ...recentHops);
    if (hereHops < recentBest) mem.triedNoProgress = {};
    recentHops.push(hereHops);
    if (recentHops.length > 60) recentHops.shift();
  }
  const used = (k: string) => mem.usedTargets[`${gs.mapName}:${k}`] ?? 0;

  const routeFacts = (dest: number, destRegions: string[]) => {
    if (inObjective(dest, destRegions)) return 'The objective is in this place (completes objective location).';
    if (hereHops === 0) return `Leaves the current area (the objective takes place in this area, ${gs.mapName}).`;
    const h = Math.min(Infinity, ...destRegions.map((r) => dist.get(r) ?? Infinity));
    if (!isFinite(h)) return isFinite(hereHops) ? 'Does not lead toward the objective (dead end for now).' : '';
    if (h < hereHops) return `Leads toward the objective (${h} area(s) away from it).`;
    if (h > hereHops) return `Leads away from the objective (${h} areas away).`;
    return `Same distance from the objective (${h} areas).`;
  };
  // distances to services (nearest Pokémon Center / Mart), for healing and shopping intents
  const serviceDist = (re: RegExp) => rg.distancesTo(Object.entries((gen as any).maps).filter(([, v]: any) => re.test(v.name)).flatMap(([id]) => rg.regionsOf(+id)), skip);
  const pcDist = serviceDist(/POKECENTER/), martDist = serviceDist(/_MART$/);
  const hereReg = hereRegion ? [hereRegion] : [];
  const svc = (regions: string[]) => {
    const f = (d: Map<string, number>, label: string) => {
      const here = Math.min(Infinity, ...hereReg.map((r) => d.get(r) ?? Infinity));
      const there = Math.min(Infinity, ...regions.map((r) => d.get(r) ?? Infinity));
      if (!isFinite(there) || !isFinite(here) || there >= here) return '';
      return there === 0 ? ` Is a ${label}.` : ` Toward the nearest ${label} (${there} areas).`;
    };
    return f(pcDist, 'Pokémon Center') + f(martDist, 'Poké Mart');
  };
  const visitFacts = (dest: number) => {
    const n = mem.visitedMaps[mapName(dest)] ?? 0;
    return n ? `Visited ${n} time(s) before.` : 'Unvisited place.';
  };

  const out: Candidate[] = [];
  const add = (key: string, desc: string, target: Target, path: Step[] | null) => {
    if (!path) return;
    const n = used(key);
    const blockedN = mem.blockedExits?.[`${gs.mapName}:${key}`] ?? 0;
    const stopSaid = mem.npcText[`${gs.mapName}:${key}:blocked`];
    const blockedNote = blockedN ? ` Tried ${blockedN} time(s) before and did NOT get through (something stopped you / sent you back).${stopSaid ? ` What was said when you were stopped: "${clip(stopSaid)}".` : ''}` : '';
    out.push({ key, target, path, desc: `${desc} ${path.length} steps away.${n ? ` Chosen ${n} time(s) already on this visit.` : ''}${blockedNote}` });
  };

  // Warps (dedupe adjacent warps with the same destination)
  const seenWarp = new Map<string, Candidate>();
  const blockers = new Map<number, string>(); // sprite index -> fact
  const lastMap = gs.u8('wLastMap');
  (md?.warps ?? []).forEach((w, wi) => {
    // LAST_MAP warps: resolve from the ROM (which map warps into this door), not from wLastMap
    let destRegions = md ? rg.warpTargets(md, wi) : [];
    // two-tile doorways: if this tile doesn't resolve, use its neighbor's destination (same door)
    if (!destRegions.length && md) {
      const twin = md.warps.findIndex((w2, j) => j !== wi && w2.destMap === w.destMap && Math.abs(w2.x - w.x) + Math.abs(w2.y - w.y) === 1);
      if (twin >= 0) destRegions = rg.warpTargets(md, twin);
    }
    if (w.destMap === 0xff && destRegions.length > 1) {
      const pref = destRegions.filter((r) => r.startsWith(`${lastMap}:`));
      if (pref.length) destRegions = pref;
    }
    let dest = w.destMap !== 0xff ? w.destMap : destRegions.length ? +destRegions[0].split(':')[0] : lastMap;
    // elevator doors lead wherever the floor panel last set them (live warp table in RAM)
    if (/ELEVATOR/.test(gs.mapName)) {
      const base = sym('wWarpEntries') + wi * 4;
      const liveMap = ctx.emu.mem[base + 3], liveWarp = ctx.emu.mem[base + 2];
      const t = liveMap !== 0xff ? rom.maps.get(liveMap)?.warps[liveWarp] : undefined;
      const r = t ? rg.regionAt(liveMap, t.x, t.y) : null;
      if (r) { dest = liveMap; destRegions = [r]; }
    }
    const k = `${dest}|${destRegions.join(',')}`;
    const blockedExceptThis = new Set(blocked); blockedExceptThis.delete(`${w.x},${w.y}`);
    const path = px === w.x && py === w.y ? [] : findPath(g, px, py, (x, y) => x === w.x && y === w.y, { blocked: blockedExceptThis, surf });
    // exit only unreachable because a person stands in the way → record that as a plain fact on that person
    if (!path) {
      const free = new Set(warpSquares); free.delete(`${w.x},${w.y}`);
      const open = findPath(g, px, py, (x, y) => x === w.x && y === w.y, { blocked: free, surf });
      // Which single person, if they weren't standing there, would open the way? (test each one on the route)
      const people = gs.sprites().filter((sp) => !sp.hidden && open?.some((st) => st.x === sp.x && st.y === sp.y));
      const openers = people.filter((sp) => {
        const without = new Set(blocked); without.delete(`${sp.x},${sp.y}`); without.delete(`${w.x},${w.y}`);
        return !!findPath(g, px, py, (x, y) => x === w.x && y === w.y, { blocked: without, surf });
      });
      for (const sp of openers) blockers.set(sp.index, `Standing in the only path to the exit at (${w.x},${w.y}) to ${mapName(dest)}. That exit: ${routeFacts(dest, destRegions)}`);
      const stopAt = open?.[0];
      const person = openers[0];
      const dbgKey = `${gs.mapName}:${w.x},${w.y}`;
      if (!loggedUnreachable.has(dbgKey)) {
        loggedUnreachable.add(dbgKey);
        ctx.log('debug', `exit (${w.x},${w.y})→${mapName(dest)} unreachable; path ignoring people: ${open ? open.length + ' steps' : 'none'}; first person on it: ${person ? `${SPRITES[person.picture]} idx${person.index} at (${person.x},${person.y})` : stopAt ? `square (${stopAt.x},${stopAt.y}) but no visible sprite there` : 'none'}`);
      }
      return;
    }
    // merge doors that lead to the same place — but only reachable ones, keeping the nearest
    const prev = seenWarp.get(k);
    if (prev && prev.path.length <= path.length) return;
    if (prev) out.splice(out.indexOf(prev), 1);
    const name = mapName(dest);
    const heal = /POKECENTER/.test(name) ? ' A Pokémon Center: the nurse heals the whole party for free. Healing here also makes it where you return if all your Pokémon faint.' : /MART/.test(name) ? ' A Poké Mart: buy items.' : /GYM/.test(name) ? ' A Pokémon Gym.' : '';
    destRegionsByKey.set(`w:${w.x},${w.y}`, destRegions);
    add(`Enter ${name}`, `Door/stairs/ladder at (${w.x},${w.y}) leading to ${name}.${heal} ${routeFacts(dest, destRegions)}${svc(destRegions)} ${visitFacts(dest)}`, { kind: 'warp', x: w.x, y: w.y, dest }, path);
    seenWarp.set(k, out[out.length - 1]);
  });

  // Map-edge connections
  for (const c of md?.connections ?? []) {
    const dir: Dir = c.dir === 'north' ? 'up' : c.dir === 'south' ? 'down' : c.dir === 'west' ? 'left' : 'right';
    const allowExit = (x: number, y: number) =>
      (dir === 'up' && y === -1) || (dir === 'down' && y === g.h) || (dir === 'left' && x === -1) || (dir === 'right' && x === g.w);
    const name = mapName(c.map);
    // only offer edge exits that land on a walkable square of the next map (not water/cliffs)
    const landsOk = (x: number, y: number) => {
      const ix = Math.min(Math.max(x, 0), g.w - 1), iy = Math.min(Math.max(y, 0), g.h - 1);
      return !!md && !!rg.connectionTarget(md, c, ix, iy);
    };
    const exitGoal = (x: number, y: number) => allowExit(x, y) && landsOk(x, y);
    const path2 = findPath(g, px, py, exitGoal, { blocked, allowExit: exitGoal, grassCost: 1, surf });
    const inside = path2 && path2.length ? (path2.length > 1 ? path2[path2.length - 2] : { x: px, y: py }) : null;
    const destRegion = inside && md ? rg.connectionTarget(md, c, inside.x, inside.y) : null;
    destRegionsByKey.set(`e:${dir}`, destRegion ? [destRegion] : []);
    add(`Go ${c.dir} to ${name}`, `Walk off the ${c.dir} edge of the map into ${name}. ${routeFacts(c.map, destRegion ? [destRegion] : [])}${svc(destRegion ? [destRegion] : [])} ${visitFacts(c.map)}`, { kind: 'exit', dir, dest: c.map }, path2);
  }

  // NPCs / objects
  for (const sp of gs.sprites()) {
    if (sp.hidden) continue;
    const spriteName = SPRITES[sp.picture] ?? `SPRITE_${sp.picture}`;
    const obj = md?.objects[sp.index - 1];
    const ig = interactGoal(g, sp.x, sp.y);
    const path = ig(px, py) ? [] : findPath(g, px, py, ig, { blocked, maxNodes: 6000 });
    const k = `${gs.mapName}:npc${sp.index}`;
    const said = mem.npcText[k];
    const OBJECTS: Record<string, string> = { POKE_BALL: 'a Poké Ball object', FOSSIL: 'a fossil lying on the ground', BOULDER: 'a boulder', POKEDEX: 'a Pokédex on a table', CLIPBOARD: 'a clipboard', PAPER: 'a piece of paper', OLD_AMBER: 'an amber stone', SNORLAX: 'a sleeping Snorlax' };
    const who = obj?.trainerClass ?? spriteName;
    const kind = obj?.item != null ? `an item ball (${rom.items.get(obj.item) ?? 'item'})` : OBJECTS[spriteName] ?? (obj?.trainer ? `a trainer (${who})` : `a person (${spriteName})`);
    const facts = `${kind} at (${sp.x},${sp.y}).${said ? ` Last time they said: "${clip(said)}".` : ' Not yet talked to.'}${spriteName === 'NURSE' ? ' Heals the whole party.' : ''}${spriteName === 'CLERK' ? ' Shop clerk: buy items.' : ''}`;
    const label = obj?.item != null ? `Pick up item ball at (${sp.x},${sp.y})` : OBJECTS[spriteName] ? `Examine the ${spriteName.toLowerCase().replace(/_/g, ' ')} at (${sp.x},${sp.y})` : `Talk to ${obj?.trainer ? who : spriteName} at (${sp.x},${sp.y})`;
    add(label, blockers.has(sp.index) ? `${facts} ${blockers.get(sp.index)}` : facts, { kind: 'npc', index: sp.index, x: sp.x, y: sp.y, sprite: spriteName }, path);
  }

  // Signs
  for (const sg of md?.signs ?? []) {
    const sgGoal = interactGoal(g, sg.x, sg.y);
    const path = sgGoal(px, py) ? [] : findPath(g, px, py, sgGoal, { blocked, maxNodes: 6000 });
    const k = `${gs.mapName}:sign${sg.x},${sg.y}`;
    const said = mem.npcText[k];
    if (/ELEVATOR/.test(gs.mapName)) add(`Use the elevator panel at (${sg.x},${sg.y})`, `The elevator's floor-select panel.${said ? ` Last time it said: "${clip(said)}".` : ''}`, { kind: 'sign', x: sg.x, y: sg.y }, path);
    else add(`Read sign at (${sg.x},${sg.y})`, said ? `A sign. It says: "${said.slice(0, 300)}".` : 'A sign, not yet read.', { kind: 'sign', x: sg.x, y: sg.y }, path);
  }

  // Hidden interactables (PCs, switches, statues, trash cans...). Hidden items are excluded: a human wouldn't know them.
  const HIDDEN_LABEL: [RegExp, string][] = [[/PokemonCenterPC|RedsPC|BillsHousePC/, 'Use the PC'], [/Switches/, 'Press the switch'], [/GymTrash/, 'Search the trash can'], [/GymStatues/, 'Read the gym statue'], [/CinnabarQuiz/, 'Use the quiz machine'], [/Fossil/, 'Examine the fossil'], [/Binoculars/, 'Look through binoculars']];
  for (const h of rom.hidden.get(gs.mapId) ?? []) {
    if (/HiddenItems|HiddenCoins|StartSlotMachine|CableClub/.test(h.fn)) continue;
    const face = [0, 4, 8, 0xc].includes(h.arg) && /PC|Switches|Quiz/.test(h.fn) ? h.arg : null;
    const standOk = (x: number, y: number) => {
      if (face === null) return adj(x, y, h.x, h.y);
      const [dx, dy] = face === 4 ? [0, 1] : face === 0 ? [0, -1] : face === 8 ? [1, 0] : [-1, 0];
      return x === h.x + dx && y === h.y + dy;
    };
    const path = standOk(px, py) ? [] : findPath(g, px, py, standOk, { blocked, maxNodes: 6000 });
    const label = HIDDEN_LABEL.find(([re]) => re.test(h.fn))?.[1] ?? `Examine ${h.fn.replace(/^(Print|Display)/, '').replace(/Text$/, '').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()}`;
    const k = `${gs.mapName}:hidden${h.x},${h.y}`;
    const said = mem.npcText[k];
    add(`${label} at (${h.x},${h.y})`, said ? `Examined before: "${clip(said)}".` : 'Not examined yet.', { kind: 'hidden', x: h.x, y: h.y, face }, path);
  }

  // Field moves (only when the party can really use them)
  const caps = capabilities(ctx);
  const surfing = gs.walkState === 2;
  if (caps.cut) {
    for (let y = 0; y < g.h; y++) for (let x = 0; x < g.w; x++) {
      if (!g.cuttable(x, y)) continue;
      const goal = (sx: number, sy: number) => adj(sx, sy, x, y);
      const path = goal(px, py) ? [] : findPath(g, px, py, goal, { blocked, maxNodes: 4000 });
      const r = rg.regionAt(gs.mapId, x, y);
      add(`Use CUT on the tree at (${x},${y})`, `A small tree that can be cut down with CUT. ${routeFacts(gs.mapId, r ? [r] : [])}`, { kind: 'cut', x, y }, path);
    }
  }
  if (caps.surf && !surfing) {
    const seenRegions = new Set<string>();
    for (let y = 0; y < g.h; y++) for (let x = 0; x < g.w; x++) {
      if (!g.water(x, y)) continue;
      const r = rg.regionAt(gs.mapId, x, y) ?? `${x},${y}`;
      if (seenRegions.has(r)) continue;
      const goal = (sx: number, sy: number) => adj(sx, sy, x, y) && g.walkable(sx, sy);
      const path = goal(px, py) ? [] : findPath(g, px, py, goal, { blocked, maxNodes: 6000 });
      if (!path) continue;
      seenRegions.add(r);
      add(`SURF onto the water at (${x},${y})`, `Start surfing on this water. ${routeFacts(gs.mapId, [r])}`, { kind: 'surf', x, y }, path);
    }
  }
  const boulders = gs.sprites().filter((s) => !s.hidden && SPRITES[s.picture] === 'BOULDER');
  if (boulders.length && slotWithMove(ctx, 'STRENGTH') >= 0 && gs.badges & 0x08) {
    if (!(gs.u8('wStatusFlags1') & 1)) add('Activate STRENGTH', 'Lets the player push boulders on this map.', { kind: 'strength' }, []);
    else for (const b of boulders) for (const d of Object.keys(DIRS) as Dir[]) {
      const [dx, dy] = DIRS[d];
      const sx = b.x - dx, sy = b.y - dy, tx = b.x + dx, ty = b.y + dy;
      if (!g.walkable(sx, sy) || !g.walkable(tx, ty) || blocked.has(`${tx},${ty}`)) continue;
      const path = sx === px && sy === py ? [] : findPath(g, px, py, (x, y) => x === sx && y === sy, { blocked, maxNodes: 6000 });
      // plain facts about the result of this push (switches/holes are visible floor features in the game)
      const feature = FLOOR_FEATURES[gs.mapName]?.find((f) => f.x === tx && f.y === ty);
      const others = new Set([...blocked].filter((k) => k !== `${b.x},${b.y}`));
      const pushable = (Object.keys(DIRS) as Dir[]).filter((d2) => {
        const [ex, ey] = DIRS[d2];
        const k1 = `${tx - ex},${ty - ey}`, k2 = `${tx + ex},${ty + ey}`;
        return g.walkable(tx - ex, ty - ey) && g.walkable(tx + ex, ty + ey) && !others.has(k1) && !others.has(k2);
      });
      const facts = [
        `Moves the boulder one square ${d} to (${tx},${ty}).`,
        feature ? `That square is a ${feature.kind === 'switch' ? 'floor switch' : 'hole in the floor'}.` : '',
        !feature && pushable.length === 0 ? 'After this push the boulder cannot be pushed from any side.' : '',
        'Boulders go back to their starting spots when you leave this area.',
      ].filter(Boolean).join(' ');
      add(`Push boulder at (${b.x},${b.y}) ${d}`, facts, { kind: 'push', x: b.x, y: b.y, dir: d }, path);
    }
  }

  // Bag items usable in the field (teach TM/HM, heal, evolve, flute, bike...)
  const party = gs.party();
  const injured = party.some((p) => p.hp < p.maxHp);
  for (const it of gs.bag()) {
    const mv = rom.machineMove(it.id);
    let desc = '';
    if (mv) {
      const knows = party.filter((p) => p.moves.some((m) => m.name === mv.name)).map((p) => p.nickname);
      const learners = party.filter((p) => rom.canLearnMachine(p.speciesId, it.id) && !knows.includes(p.nickname));
      if (!learners.length) continue; // nobody can learn it
      desc = `Can be learned by: ${learners.map((p) => p.species).join(', ')}. `;
      desc += `Teach ${mv.name} (${mv.type}, power ${mv.power}, accuracy ${mv.accuracy}%) to a party Pokémon.${knows.length ? ` Already known by ${knows.join(', ')}.` : ''}${/^HM/.test(it.name) ? ' HM moves enable field abilities (CUT, SURF, STRENGTH...).' : ''}`;
    } else if (/POTION|FRESH WATER|SODA POP|LEMONADE|FULL RESTORE|REVIVE|ANTIDOTE|PARLYZ HEAL|AWAKENING|BURN HEAL|ICE HEAL|FULL HEAL/.test(it.name)) {
      if (!injured && !/REVIVE/.test(it.name) && !party.some((p) => p.status !== 'OK')) continue;
      desc = `Use on a Pokémon (heal / cure). ${it.qty} left.`;
    } else if (/STONE$/.test(it.name)) {
      const evolvers = party.filter((p) => rom.species.get(p.speciesId)?.stoneEvos.includes(it.id));
      if (!evolvers.length) continue; // no one in the party evolves with this stone
      desc = `Evolves ${evolvers.map((p) => p.species).join(', ')}.`;
    }
    else if (/RARE CANDY/.test(it.name)) desc = 'Raises a Pokémon by one level.';
    else if (/POKé FLUTE/.test(it.name)) desc = 'Plays a tune that wakes up sleeping Pokémon (like a Snorlax blocking a road).';
    else if (/BICYCLE/.test(it.name)) desc = surfing ? '' : 'Ride the bicycle (faster travel).';
    else if (/ESCAPE ROPE/.test(it.name)) desc = 'Escape from a cave/dungeon back to the last Pokémon Center.';
    if (!desc) continue;
    add(`Use ${it.name} from the bag`, desc, { kind: 'item', name: it.name }, []);
  }

  // Tall grass (wild encounters: train / catch)
  const gp = findPath(g, px, py, (x, y) => g.grass(x, y), { blocked, maxNodes: 8000 });
  if (gp) add('Walk in tall grass', 'Wander in tall grass to find wild Pokémon (gain experience / catch new team members).', { kind: 'grass' }, gp);

  // Explore unseen squares
  const seenSq = mem.stepsInMap[gs.mapName] ?? new Set();
  const ep = findPath(g, px, py, (x, y) => !seenSq.has(`${x},${y}`) && Math.abs(x - px) + Math.abs(y - py) >= 6, { blocked, maxNodes: 8000 });
  if (ep) add('Explore this area', `Walk to a part of ${gs.mapName} not yet explored.`, { kind: 'explore' }, ep);

  // Distinct options must have distinct names (e.g. several ladders to the same floor lead to different areas)
  const counts = new Map<string, number>();
  for (const c of out) counts.set(c.key, (counts.get(c.key) ?? 0) + 1);
  for (const c of out) {
    if ((counts.get(c.key) ?? 0) < 2) continue;
    const t = c.target as { x?: number; y?: number };
    if (t.x !== undefined) c.key = c.key.replace(/^Enter /, `Take the exit at (${t.x},${t.y}) to `);
  }
  return out;
}

type WalkResult = 'ok' | 'blocked' | 'interrupted' | 'warped' | 'moved';

function waitWalkDone(ctx: Ctx) {
  for (let i = 0; i < 30 && ctx.emu.mem[sym('wWalkCounter')] !== 0; i++) ctx.emu.frame();
}

/** Wait until the game hands control back for a while (the flags drop briefly between arrow tiles). False if a battle/text started. */
function waitControl(ctx: Ctx): boolean {
  const { gs, emu } = ctx;
  for (let f = 0, calm = 0; f < 1200 && calm < 16; f++) {
    emu.frame();
    if (gs.inBattle || gs.screen().hasTextBox) return false;
    calm = (gs.joyIgnore & 0xf0) || (gs.u8('wStatusFlags5') & 0x80) || emu.mem[sym('wWalkCounter')] !== 0 ? 0 : calm + 1;
  }
  return true;
}

/** Execute path steps. Stops on map change, text box, battle, or blockage. */
function walk(ctx: Ctx, path: Step[]): WalkResult {
  const { gs, emu } = ctx;
  const map0 = gs.mapId;
  for (const st of path) {
    const x0 = gs.x, y0 = gs.y;
    const btn = st.dir.toUpperCase() as 'UP';
    let moved = false;
    // first press may only turn the player; allow a second attempt
    for (let f = 0; f < 40; f++) {
      emu.frame([btn]);
      if (gs.x !== x0 || gs.y !== y0 || gs.mapId !== map0) { moved = true; break; }
      if (gs.inBattle || gs.screen().hasTextBox) break;
    }
    waitWalkDone(ctx);
    if (st.jump) emu.wait(20);
    if (st.spin) {
      // arrow tile: the game moves the player for us; wait it out, then make sure we landed as predicted
      if (!waitControl(ctx)) return 'interrupted';
      if (gs.mapId !== map0) { settleAfterMapChange(ctx); return 'warped'; }
      if (gs.x !== st.x || gs.y !== st.y) return 'moved'; // landed elsewhere: replan from here
      continue;
    }
    const steps = (ctx.mem.stepsInMap[gs.mapName] ??= new Set());
    steps.add(`${gs.x},${gs.y}`);
    if (gs.mapId !== map0) { settleAfterMapChange(ctx); return 'warped'; }
    if (gs.inBattle || gs.screen().hasTextBox) return 'interrupted';
    // the game took control of the player: a trainer walking over, or an arrow tile sliding us along
    if (!moved && ((gs.joyIgnore & 0xf0) || (gs.u8('wStatusFlags5') & 0x80))) {
      if (!waitControl(ctx)) return 'interrupted';
      if (gs.inBattle || gs.screen().hasTextBox || gs.u8('wCurOpponent')) return 'interrupted';
      if (gs.mapId !== map0) { settleAfterMapChange(ctx); return 'warped'; }
      return 'moved'; // silently moved somewhere else: replan
    }
    if (!moved) return 'blocked';
  }
  return 'ok';
}

function face(ctx: Ctx, tx: number, ty: number) {
  const dx = Math.sign(tx - ctx.gs.x), dy = Math.sign(ty - ctx.gs.y);
  const d = dx > 0 ? 'RIGHT' : dx < 0 ? 'LEFT' : dy > 0 ? 'DOWN' : 'UP';
  const want = { DOWN: 0, UP: 4, LEFT: 8, RIGHT: 0xc }[d];
  const facing = () => ctx.emu.mem[sym('wSpritePlayerStateData1FacingDirection')];
  // a tap right after a walk can be dropped; retry until the player actually faces the target
  for (let i = 0; i < 4 && (i === 0 || facing() !== want); i++) {
    waitWalkDone(ctx);
    ctx.emu.press(d, 3, 6);
  }
}

export async function execute(ctx: Ctx, c: Candidate, agent: Agent): Promise<WalkResult | undefined> {
  const { gs, emu } = ctx;
  const t = c.target;
  let res = walk(ctx, c.path);
  // replan to the same target from wherever we ended up: someone stepped in the way (once),
  // or arrow tiles etc. slid us somewhere (keep going)
  let blockedRetries = 1;
  for (let i = 0; i < 12 && (res === 'moved' || (res === 'blocked' && blockedRetries-- > 0)); i++) {
    if (res === 'blocked') emu.wait(20);
    const again = buildCandidates(ctx).find((k) => k.key === c.key);
    if (!again) break;
    res = walk(ctx, again.path);
  }
  if (res === 'moved') return res;
  if (res === 'interrupted') { pendingTarget = { map: gs.mapId, key: c.key, resumes: resumingCount + 1 }; return res; }
  if (res !== 'ok') return res;
  switch (t.kind) {
    case 'warp': {
      emu.wait(20);
      // carpet/edge warps need a push toward the edge
      const map0 = gs.mapId;
      const last = c.path[c.path.length - 1]?.dir;
      for (const d of [last, 'down', 'up', 'left', 'right'].filter(Boolean) as Dir[]) {
        emu.hold(d.toUpperCase() as 'UP', 16);
        emu.wait(20);
        if (gs.mapId !== map0 || gs.screen().hasTextBox) break;
      }
      return;
    }
    case 'npc': {
      const sp = gs.sprites().find((s) => s.index === t.index);
      const tx = sp?.x ?? t.x, ty = sp?.y ?? t.y;
      ctx.mem.lastInteraction = `${gs.mapName}:npc${t.index}`;
      ctx.mem.currentTalk = [];
      ctx.mem.talked[ctx.mem.lastInteraction] = (ctx.mem.talked[ctx.mem.lastInteraction] ?? 0) + 1;
      face(ctx, tx, ty);
      tap(ctx, 'A', 20);
      return;
    }
    case 'sign': {
      ctx.mem.lastInteraction = `${gs.mapName}:sign${t.x},${t.y}`;
      ctx.mem.currentTalk = [];
      face(ctx, t.x, t.y);
      tap(ctx, 'A', 20);
      return;
    }
    case 'hidden': {
      ctx.mem.lastInteraction = `${gs.mapName}:hidden${t.x},${t.y}`;
      ctx.mem.currentTalk = [];
      face(ctx, t.x, t.y);
      tap(ctx, 'A', 20);
      return;
    }
    case 'cut': {
      face(ctx, t.x, t.y);
      useFieldMove(ctx, slotWithMove(ctx, 'CUT'), 'CUT');
      return;
    }
    case 'surf': {
      face(ctx, t.x, t.y);
      useFieldMove(ctx, slotWithMove(ctx, 'SURF'), 'SURF');
      return;
    }
    case 'strength': {
      useFieldMove(ctx, slotWithMove(ctx, 'STRENGTH'), 'STRENGTH');
      return;
    }
    case 'push': {
      emu.hold(t.dir.toUpperCase() as 'UP', 60);
      emu.wait(30);
      return;
    }
    case 'item': {
      if (!useItem(ctx, t.name)) closeMenus(ctx);
      return;
    }
    case 'grass': {
      // pace inside the grass until something happens
      const g = buildGrid(ctx.emu, ctx.rom, gs);
      for (let i = 0; i < 40 && !gs.inBattle && !gs.screen().hasTextBox; i++) {
        const opts = (Object.keys(DIRS) as Dir[]).filter((d) => { const [dx, dy] = DIRS[d]; return g.grass(gs.x + dx, gs.y + dy); });
        if (!opts.length) break;
        walk(ctx, [{ dir: opts[Math.floor(Math.random() * opts.length)], x: 0, y: 0 }]);
      }
      return;
    }
    default:
      return;
  }
}

// Floor switches / holes that boulders can be pushed onto (visible in-game; coords from the map scripts).
const FLOOR_FEATURES: Record<string, { x: number; y: number; kind: 'switch' | 'hole' }[]> = {
  VICTORY_ROAD_1F: [{ x: 17, y: 13, kind: 'switch' }],
  VICTORY_ROAD_2F: [{ x: 1, y: 16, kind: 'switch' }, { x: 9, y: 16, kind: 'switch' }],
  VICTORY_ROAD_3F: [{ x: 3, y: 5, kind: 'switch' }, { x: 23, y: 15, kind: 'hole' }],
};

const FOCUS_TTL = 30;
let lastMapWasMart = false;
const MAX_REPEATS_NO_PROGRESS = +(process.env.MAX_REPEATS_NO_PROGRESS ?? 5);

const INTENTS: Record<string, string> = {
  progress: 'Move toward the current objective now.',
  heal: 'Go heal the party at a Pokémon Center.',
  train: 'Train: fight wild Pokémon in tall grass to gain levels before the objective.',
  catch: 'Catch new wild Pokémon to build a stronger, more varied team.',
  shop: 'Buy supplies (Poké Balls, Potions) at a Poké Mart.',
  explore: 'Talk to people / explore this area for items or information.',
  team: "Change the team at a Pokémon Center PC (BILL's PC): deposit team members and withdraw Pokémon from the box.",
};

function teamSignature(ctx: Ctx) {
  return `${ctx.gs.party().map((p) => p.species + p.level).join(',')}|${ctx.gs.box().map((m) => m.species + m.level).join(',')}`;
}

/** High-level intent, re-decided only when the situation changes (keeps Jev calls low). */
async function decideIntent(ctx: Ctx): Promise<string> {
  const { gs } = ctx;
  const party = gs.party();
  // Focus sticks until the situation meaningfully changes (not on every map change, which caused back-and-forth).
  // Re-ask only on decisive changes (a faint, HP under 25%, badge/goal/items/levels) — small HP dips from
  // wild battles made the focus flip between progress and heal and walk back and forth.
  const hpFrac = party.reduce((a, p) => a + p.hp, 0) / Math.max(1, party.reduce((a, p) => a + p.maxHp, 0));
  const fainted = party.filter((p) => p.hp === 0).length;
  const key = `${hpFrac < 0.25 ? 'low' : 'ok'}|${fainted}|${party.map((p) => p.level).join(',')}|${gs.badges}|${currentMilestone(gs).index}|${gs.bag().map((i) => i.name).join(',')}|${Math.floor(gs.money / 500)}`;
  // re-ask Jev every FOCUS_TTL overworld decisions even if nothing changed, so a focus can't trap it
  // a finished focus is re-asked (e.g. 'heal' once everyone is at full HP with no status problems)
  const healed = party.every((p) => p.hp === p.maxHp && p.status === 'OK');
  // 'shop' is done once we've left a Mart (bought or not), so it can't send us straight back in
  const leftMart = ctx.mem.intent?.value === 'shop' && !/MART/.test(gs.mapName) && lastMapWasMart;
  lastMapWasMart = false; // one-shot: only the first decision after leaving a Mart
  const done = (ctx.mem.intent?.value === 'heal' && healed) || leftMart || (ctx.mem.intent?.value === 'shop' && !!ctx.mem.shopDone) || (ctx.mem.intent?.value === 'team' && !!ctx.mem.pcDone);
  if (done && ctx.mem.intent?.value === 'team') ctx.mem.teamSig = teamSignature(ctx);
  if (done) { ctx.mem.shopDone = false; ctx.mem.pcDone = false; }
  if (!done && ctx.mem.intent?.key === key && (ctx.mem.intent.age = (ctx.mem.intent.age ?? 0) + 1) <= FOCUS_TTL) return ctx.mem.intent.value;
  const balls = gs.bag().filter((i) => /BALL$/.test(i.name)).reduce((a, i) => a + i.qty, 0);
  const criteria = { ...INTENTS };
  criteria.catch = `${INTENTS.catch} Team size ${party.length}/6. Poké Balls in bag: ${balls}.`;
  criteria.shop = `${INTENTS.shop} Money: ¥${gs.money}. Prices: Poké Ball ¥200, Potion ¥300, Antidote ¥100.`;
  // impossible focuses aren't offered (same rule as unusable items)
  if (gs.money < 100) delete (criteria as Record<string, string>).shop;
  if (balls === 0 && gs.money < 200) delete (criteria as Record<string, string>).catch;
  criteria.heal = `${INTENTS.heal} Healing at a Pokémon Center is free.`;
  // swapping is only possible with Pokémon in the box
  const box = gs.box();
  // offered only when there's something in the box, and the team/box changed since the PC was last used
  if (box.length && ctx.mem.teamSig !== teamSignature(ctx)) {
    const lvls = party.map((p) => p.level);
    criteria.team = `${INTENTS.team} In the box: ${box.map((m) => `${m.nickname} (${m.species} Lv${m.level}, ${m.types.join('/')})`).join(', ')}. Team: ${party.map((p) => `${p.nickname} (${p.species} Lv${p.level}, ${p.types.join('/')})`).join(', ')}. Team levels range ${Math.min(...lvls)}-${Math.max(...lvls)}.`;
  } else delete (criteria as Record<string, string>).team;
  criteria.train = `${INTENTS.train} Beating trainers also earns money.`;
  const { picked } = await ctx.jev.ask('intent', situation(ctx), {
    intent: { type: 'choice', instructions: 'You are playing Pokémon Red. Given the objective, the party\'s health and levels (vs the typical opponent level of the objective), money and items, what should the player focus on right now?', criteria },
  });
  const value = picked.intent as string;
  ctx.mem.intent = { value, key, age: 0 };
  ctx.mem.shopDone = false;
  ctx.mem.pcDone = false;
  ctx.log('decision', `intent → ${value}`);
  return value;
}

/** After a warp, wait until the new map is fully loaded (map id, position and sprites stable, input enabled). */
function settleAfterMapChange(ctx: Ctx) {
  const { gs, emu } = ctx;
  emu.wait(45); // let the warp fade finish before trusting anything (a fade can look 'stable')
  let last = '', stable = 0;
  for (let f = 0; f < 400 && stable < 30; f++) {
    const snap = `${gs.mapId}|${gs.x},${gs.y}|${gs.joyIgnore}|${gs.sprites().map((s) => `${s.x},${s.y},${s.hidden}`).join(';')}`;
    stable = snap === last && gs.joyIgnore === 0 ? stable + 1 : 0;
    last = snap;
    emu.frame();
  }
}

let lastDecisionMap = -1;
// a walk Jev chose that got interrupted (battle/dialog): resume it instead of re-asking
let pendingTarget: { map: number; key: string; resumes: number } | null = null;
let resumingCount = 0;
const recentHops: number[] = [];

/**
 * True when the game is back in its overworld loop, taking input. A script can keep running with no
 * text box on screen (e.g. sound/animation delays after a text); input is ignored until it returns.
 * Checked from the CPU: waiting in DelayFrame, called from the overworld loop code.
 */
function overworldReady(ctx: Ctx): boolean {
  const core = ctx.emu.core, lo = sym('EnterMap'), hi = sym('JoypadOverworld'), df = sym('DelayFrame');
  for (let i = 0; i < 4; i++) {
    const pc = core.programCounter, sp = core.stackPointer;
    const ret = core.memoryRead(sp) | (core.memoryRead(sp + 1) << 8);
    if (pc >= df && pc < df + 12 && ret >= lo && ret < hi) return true;
    ctx.emu.frame();
  }
  return false;
}
let busyWaited = 0;

export async function overworldStep(ctx: Ctx, agent: Agent) {
  // a script is still running without a text box: wait for it (capped, so this can never hang)
  if (busyWaited < 1800 && !overworldReady(ctx)) { ctx.emu.wait(20); busyWaited += 24; return; }
  busyWaited = 0;
  if (ctx.gs.mapId !== lastDecisionMap) {
    lastMapWasMart = /MART/.test(mapName(lastDecisionMap));
    // gym trash-can switches are re-placed on every entry: earlier findings no longer hold
    for (const h of ctx.rom.hidden.get(ctx.gs.mapId) ?? []) if (/GymTrash/.test(h.fn)) delete ctx.mem.npcText[`${ctx.gs.mapName}:hidden${h.x},${h.y}`];
    settleAfterMapChange(ctx);
    lastDecisionMap = ctx.gs.mapId;
    if (agent.mode() !== 'overworld') return; // a script/dialog started while arriving
  }
  // resume Jev's interrupted choice (same map, still available, at most 3 times)
  if (pendingTarget && pendingTarget.map === ctx.gs.mapId && pendingTarget.resumes <= 3) {
    const again = buildCandidates(ctx).find((k) => k.key === pendingTarget!.key);
    if (again) {
      ctx.log('info', `resuming "${again.key}" after an interruption (${pendingTarget.resumes}/3)`);
      resumingCount = pendingTarget.resumes;
      pendingTarget = null;
      await execute(ctx, again, agent);
      resumingCount = 0;
      return;
    }
  }
  pendingTarget = null;
  const intent = await decideIntent(ctx);
  const cands = buildCandidates(ctx);
  if (!cands.length) {
    ctx.log('warn', 'no reachable targets; waiting');
    tap(ctx, 'B', 30);
    return;
  }
  // Loop rule: tag options already tried without progress; drop ones repeated too often (until progress resets it)
  const tried = ctx.mem.triedNoProgress;
  const tk = (c: Candidate) => `${ctx.gs.mapName}:${c.key}`;
  const towardObjective = (c: Candidate) => /Leads toward the objective|objective is in this place/.test(c.desc);
  let pool = cands.filter((c) => towardObjective(c) || (tried[tk(c)] ?? 0) < MAX_REPEATS_NO_PROGRESS);
  if (!pool.length) { ctx.mem.triedNoProgress = {}; pool = cands; }
  const criteria: Record<string, string> = {};
  const FOCUS: Record<string, RegExp> = {
    heal: /Pokémon Center|heals the whole party|NURSE/,
    shop: /Poké Mart|Shop clerk|CLERK/,
    team: /Use the PC|Pokémon Center/,
    train: /tall grass/,
    catch: /tall grass/,
    progress: /Leads toward the objective|objective is in this place|objective takes place/,
  };
  for (const c of pool) {
    const n = tried[tk(c)] ?? 0;
    const fits = FOCUS[intent]?.test(`${c.key} ${c.desc}`) ? ' Matches your current focus.' : '';
    criteria[c.key] = c.desc + fits + (n ? ` ALREADY TRIED ${n} time(s) since the last progress and nothing changed.` : '');
  }
  const repeated = Object.entries(tried).filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1])[0];
  const loopRule = 'Rule: if an action was already tried and nothing changed, do NOT repeat it — try something new (a different person, exit, or area).';
  const loopNote = repeated ? ` Warning: you are looping — "${repeated[0].split(':').slice(1).join(':')}" was done ${repeated[1]} times with no progress. Pick a different action.` : '';
  const state = { ...situation(ctx), currentFocus: INTENTS[intent], position: { x: ctx.gs.x, y: ctx.gs.y, map: ctx.gs.mapName } };
  // Follow Jev's top pick; only explore (sample) when that exact pick was already tried repeatedly with no change.
  const prevExplore = ctx.jev.explore;
  ctx.jev.explore = false;
  const { answers } = await ctx.jev.ask('overworld', state, {
    decision: {
      type: 'choice',
      instructions: `You are playing Pokémon Red. Current focus: ${INTENTS[intent]} Choose the overworld action that best serves this focus and the objective. ${loopRule}${loopNote}`,
      criteria,
    },
  });
  ctx.jev.explore = prevExplore;
  const ans = answers.decision as { choice: string; probabilities?: Record<string, number> };
  let key = ans.choice;
  if ((tried[`${ctx.gs.mapName}:${key}`] ?? 0) >= 3 && ans.probabilities) {
    const alts = Object.entries(ans.probabilities).filter(([k]) => k !== key);
    const total = alts.reduce((a, [, p]) => a + p + 0.05, 0);
    let r = Math.random() * total;
    for (const [k, p] of alts) { r -= p + 0.05; if (r <= 0) { key = k; break; } }
    ctx.log('info', `"${ans.choice}" already tried ${tried[`${ctx.gs.mapName}:${ans.choice}`]}x with no change → trying "${key}" instead`);
  }
  const c = pool.find((k) => k.key === key)!;
  tried[tk(c)] = (tried[tk(c)] ?? 0) + 1;
  const uk = `${ctx.gs.mapName}:${c.key}`;
  ctx.mem.usedTargets[uk] = (ctx.mem.usedTargets[uk] ?? 0) + 1;
  agent.noteDecision(`${ctx.gs.mapName}: ${c.key}`);
  ctx.log('decision', `${ctx.gs.mapName}: ${c.key}`, { options: cands.length });
  ctx.mem.lastInteraction = null;
  const mapBefore = ctx.gs.mapId, mapNameBefore = ctx.gs.mapName;
  const fromRegion = regionGraph(ctx).regionAt(mapBefore, ctx.gs.x, ctx.gs.y);
  const tg = c.target as { kind: string; x?: number; y?: number; dir?: string };
  const edges = (destRegionsByKey.get(tg.kind === 'warp' ? `w:${tg.x},${tg.y}` : `e:${tg.dir}`) ?? []).map((r) => `${fromRegion}>${r}`);
  const res = await execute(ctx, c, agent);
  const bE = (ctx.mem.blockedEdges ??= {});
  if (ctx.gs.mapId !== mapBefore) for (const e of edges) delete bE[e]; // it worked this time
  // a trainer battle cut the walk short: not a failed attempt, it gets resumed
  const battleInterrupt = () => { tried[tk(c)] = Math.max(0, (tried[tk(c)] ?? 1) - 1); };
  const isExit = (c.target.kind === 'exit' || c.target.kind === 'warp') && c.path.length > 0;
  if (isExit || res === 'interrupted') {
    // settle any dialog/cutscene the attempt caused (keeping what was said), then check whether we got there
    const said: string[] = [];
    const settleTap = () => {
      const sc = ctx.gs.screen();
      if (sc.dialog && said[said.length - 1] !== sc.dialog) {
        if (said.length && sc.dialog.startsWith(said[said.length - 1])) said[said.length - 1] = sc.dialog; else said.push(sc.dialog);
      }
      if (sc.hasTextBox && !sc.cursor) tap(ctx, 'A', 8); else ctx.emu.frame();
    };
    for (let i = 0; i < 400 && !ctx.gs.inBattle && (ctx.gs.screen().hasTextBox || (ctx.gs.joyIgnore & 0xf0) || (ctx.gs.u8('wStatusFlags5') & 0x80)); i++) settleTap();
    // a trainer's battle can start a moment after its text closes
    const battleComing = () => ctx.gs.inBattle || ctx.gs.u8('wCurOpponent') !== 0; // set when a trainer engages
    for (let i = 0; i < 300 && ctx.gs.mapId === mapBefore && !battleComing(); i++) settleTap();
    if (battleComing()) { battleInterrupt(); return; }
    // stopped = a speech sent us back, or the walk finished and we're still here; a silent interruption
    // (ledge hop, cutscene) is not a failure: the walk gets resumed
    if (ctx.gs.mapId === mapBefore && (said.length || (isExit && res !== 'interrupted'))) {
      const k = `${mapNameBefore}:${c.key}`;
      ctx.mem.blockedExits[k] = (ctx.mem.blockedExits[k] ?? 0) + 1;
      if (said.length) ctx.mem.npcText[`${k}:blocked`] = said.join(' ').slice(-1500);
      if (isExit && fromRegion) for (const e of edges) bE[e] = (bE[e] ?? 0) + 1;
      pendingTarget = null; // stopped, not merely interrupted: let Jev decide again
      ctx.log('info', `${c.key}: did not get through (${ctx.mem.blockedExits[k]}x, walk ${res}, at ${ctx.gs.x},${ctx.gs.y})${said.length ? ` — "${said.join(' ').slice(0, 80)}"` : ''}`);
    }
  }
}
