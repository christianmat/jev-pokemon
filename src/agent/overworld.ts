import type { Ctx } from './context.js';
import { tap, situation, regionGraph, weakTeamNote } from './context.js';
import type { Agent } from './agent.js';
import { buildGrid, findPath, DIRS, type Dir, type Grid, type Step } from '../game/world.js';
import { sym, mapName } from '../game/symbols.js';
import gen from '../data/generated.json' with { type: 'json' };
import { currentMilestone, missingNeed } from '../knowledge/milestones.js';
import { useFieldMove, useItem, tossItem, slotWithMove, closeMenus } from './field.js';
import { resetMenuRepeats } from './menus.js';
import { capabilities, fieldMoveLearners } from './context.js';
import { RegionGraph, HOLES, SWITCH_GATES, SWITCH_EVENT, switchDistances } from '../game/regions.js';
/** region graphs for capabilities the party doesn't have yet (to tell whether CUT/SURF is what's missing) */
const hypoGraphs = new Map<string, RegionGraph>();
/** per map: walkability when last seen (live), used for maps other than the current one */
const seenWalk = new Map<number, { walk: (x: number, y: number) => boolean; key: string }>();
const hashStr = (t: string) => { let h = 0; for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) | 0; return h; };

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
  | { kind: 'toss'; name: string }
  | { kind: 'exit'; dir: Dir; dest: number }
  | { kind: 'npc'; index: number; x: number; y: number; sprite: string }
  | { kind: 'sign'; x: number; y: number }
  | { kind: 'grass' }
  | { kind: 'explore' };

interface Candidate { key: string; desc: string; target: Target; path: Step[] }
/** destination regions of the exit candidates built last (for learning blocked edges) */
const destRegionsByKey = new Map<string, string[]>();

const adj = (x: number, y: number, tx: number, ty: number) => Math.abs(x - tx) + Math.abs(y - ty) === 1;
/** A gym objective without an exact spot: the square in front of the gym leader (from the map's object data). */
const LEADERS = /^(BROCK|MISTY|LT\.?SURGE|ERIKA|KOGA|SABRINA|BLAINE|GIOVANNI)$/;
function gymLeaderSpot(rom: Ctx['rom'], maps: string[]) {
  for (const name of maps) {
    if (!/_GYM$/.test(name)) continue;
    const md = [...rom.maps.values()].find((mm) => mm.name === name);
    const o = md?.objects.find((ob) => ob.trainer && LEADERS.test(ob.trainerClass ?? ''));
    if (md && o) return { map: name, x: o.x, y: o.y + 1 };
  }
  return undefined;
}
/** An objective to find an item: the square of that item's ball on the objective map (the item is named in the goal). */
function goalItemSpot(rom: Ctx['rom'], maps: string[], goal: string) {
  const letters = (t: string) => t.toUpperCase().replace(/[^A-Z]/g, '');
  const g = letters(goal);
  for (const name of maps) {
    const md = [...rom.maps.values()].find((mm) => mm.name === name);
    for (const o of md?.objects ?? []) {
      const item = o.item != null ? rom.items.get(o.item) : undefined;
      if (item && letters(item).length >= 5 && g.includes(letters(item))) return { map: name, x: o.x, y: o.y };
    }
  }
  return undefined;
}
/** Silph Co. card-key door tile (the game checks the tile in front of the player on these floors). */
const cardKeyDoor = (gs: { mapName: string }, g: Grid, x: number, y: number) => {
  if (!/^SILPH_CO_([2-9]|1[01])F$/.test(gs.mapName)) return false;
  const t = g.tile(x, y);
  return t === 0x18 || t === 0x24 || (gs.mapName === 'SILPH_CO_11F' && t === 0x5e);
};
const hasCardKey = (gs: Ctx['gs']) => gs.bag().some((i) => i.name === 'CARD KEY');

function blockedSquares(ctx: Ctx, exceptIndex = -1): Set<string> {
  const s = new Set<string>();
  for (const sp of ctx.gs.sprites()) if (!sp.hidden && sp.index !== exceptIndex) s.add(`${sp.x},${sp.y}`);
  // squares where stepping on triggered a speech that sent us back (e.g. a locked door's script): walk around them
  for (const k of ctx.mem.trapSquares?.[ctx.gs.mapName] ?? []) s.add(k);
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
  const warpSquares = new Set([...(md?.warps ?? []).map((w) => `${w.x},${w.y}`), ...HOLES.filter((h) => h.from === gs.mapName).map((h) => `${h.x},${h.y}`)]);
  // people and boulders standing somewhere right now (sprites only)
  const occupied = new Set(gs.sprites().filter((sp) => !sp.hidden).map((sp) => `${sp.x},${sp.y}`));
  const blocked = new Set([...blockedSquares(ctx), ...warpSquares]);
  // the game's boulder rule: the square two ahead must be passable, not stairs ($15), and not across an elevation
  // difference from the square the player pushes from
  const boulderCanGo = (sx: number, sy: number, tx: number, ty: number) =>
    g.walkable(tx, ty) && g.tile(tx, ty) !== 0x15 && !g.pairBlocked(g.tile(sx, sy), g.tile(tx, ty));
  const surf = gs.walkState === 2;
  // a boulder moved from its starting spot goes back when you leave the area: say so on the exits
  const movedBoulder = gs.sprites().some((sp) => {
    if (sp.hidden || SPRITES[sp.picture] !== 'BOULDER') return false;
    const o = md?.objects.find((ob) => ob.index === sp.index);
    return !!o && (o.x !== sp.x || o.y !== sp.y);
  });
  const leaveNote = movedBoulder ? ' Leaving puts the boulders you moved on this floor back at their starting spots.' : '';
  const { m } = currentMilestone(gs);
  // a prerequisite item not in the bag yet: head to where it's found first
  // people who never move stand in corridors like walls: split this map's regions around them
  {
    const stay = new Set<string>();
    for (const sp of gs.sprites()) {
      const o = md?.objects[sp.index - 1];
      if (!sp.hidden && o && o.movement === 0xff && o.item == null) stay.add(`${sp.x},${sp.y}`);
    }
    // live walkability too (doors opened/closed by events differ from the map's static data)
    // a locked Silph Co. door counts as passable for routing once the CARD KEY is in the bag (it opens with A)
    const keyDoor = hasCardKey(gs) ? (x: number, y: number) => cardKeyDoor(gs, g, x, y) : () => false;
    // same rules as the static graph: trees count as passable with CUT, water with SURF
    const fm = capabilities(ctx);
    const walk = (x: number, y: number) => g.walkable(x, y) || keyDoor(x, y) || (fm.cut && g.cuttable(x, y)) || (fm.surf && g.water(x, y));
    let wk = ''; for (let y = 0; y < g.h; y++) for (let x = 0; x < g.w; x++) wk += walk(x, y) ? '1' : '0';
    // remember how this map looks now; other maps use their last-seen look (a switch press can change them: forgotten then)
    if (mem.switchPressedOn) seenWalk.clear();
    const bits = wk, w = g.w;
    seenWalk.set(gs.mapId, { walk: (x: number, y: number) => x >= 0 && y >= 0 && x < w && bits[y * w + x] === '1', key: String(hashStr(wk)) });
    // switch-gated buildings (Pokémon Mansion): model every floor's gates from the game's switch flag
    if (SWITCH_GATES.some((x) => x.map === gs.mapName)) rg.setSwitch(gs.event(SWITCH_EVENT));
    // switch-gated floors are modelled exactly from the switch flag: never use (possibly stale) snapshots for them
    const others = new Map([...seenWalk].filter(([id]) => !SWITCH_GATES.some((x) => x.map === mapName(id))));
    rg.refine(gs.mapId, stay, walk, wk, others);
  }
  const need = missingNeed(m, gs);
  // a prerequisite just arrived: what blocked us before (e.g. guards wanting it) may be open now
  if (mem.needsMissing && mem.needsMissing !== need?.what) {
    mem.blockedEdges = {}; mem.blockedExits = {};
    for (const k of Object.keys(mem.npcText)) if (k.endsWith(':blocked')) delete mem.npcText[k];
    ctx.log('info', `got ${mem.needsMissing}: cleared earlier "did not get through" records`);
  }
  mem.needsMissing = need?.what;
  // a new badge / objective / item can open what stopped us before: forget the "did not get through" counts then
  const blockSig = `${gs.badges}|${currentMilestone(gs).index}|${gs.bag().map((i) => i.name).sort().join(',')}`;
  if (mem.blockSig !== undefined && mem.blockSig !== blockSig) mem.blockedExits = {};
  // push-back squares: forget them on a new badge / objective
  const trapSig = `${gs.badges}|${currentMilestone(gs).index}`;
  const newItem = gs.bag().some((i) => !(mem.trapBag ?? []).includes(i.name));
  // (keys that open such doors complete an objective, so a new objective covers them; ordinary pickups don't reset)
  if (mem.trapSig !== undefined && mem.trapSig !== trapSig) mem.trapSquares = {};
  void newItem;
  mem.trapSig = trapSig;
  mem.trapBag = [...new Set([...(mem.trapBag ?? []), ...gs.bag().map((i) => i.name)])];
  mem.blockSig = blockSig;
  const needsItem = !!need;
  const objMaps = (need ? need.maps : m?.maps ?? []).map((n) => Object.entries((gen as any).maps).find(([, v]: any) => v.name === n)?.[0]).filter(Boolean).map(Number);
  // exits that stopped us at least twice are left out of route distances until one works again
  const skip = new Set(Object.entries(mem.blockedEdges ?? {}).filter(([, n]) => n >= 2).map(([e]) => e));
  // the objective's area: a specific spot when the milestone gives one (a map can have unconnected parts)
  const at = need ? need.at : m?.at ?? gymLeaderSpot(rom, m?.maps ?? []) ?? goalItemSpot(rom, m?.maps ?? [], m?.goal ?? '');
  const atMap = at ? objMaps.find((id) => mapName(id) === at.map) : undefined;
  let atRegion = atMap !== undefined && at ? rg.regionAt(atMap, at.x, at.y) : null;
  let objRegions = atRegion ? [atRegion] : objMaps.flatMap((id) => rg.regionsOf(id));
  let objMapsNow = objMaps;
  const inObjective = (map: number, regions: (string | null)[]) => (atRegion ? regions.includes(atRegion) : objMapsNow.includes(map));
  let dist = rg.distancesTo(objRegions, skip);
  destRegionsByKey.clear();
  let hereRegion = rg.regionAt(gs.mapId, px, py);
  let hereHops = inObjective(gs.mapId, [hereRegion]) ? 0 : (hereRegion ? dist.get(hereRegion) : undefined) ?? Infinity;
  // in a switch-gated building: routes may need a switch press on the way (both switch positions, presses as steps)
  switchAfter = null;
  // (whenever we're inside the building: its gates decide the way out too, whatever the objective)
  const gatedHere = SWITCH_GATES.some((x) => x.map === gs.mapName);
  if (gatedHere) {
    const on = gs.event(SWITCH_EVENT);
    const ck = `switch:${!on}|${capabilities(ctx).cut}|${capabilities(ctx).surf}`;
    const alt = hypoGraphs.get(ck) ?? hypoGraphs.set(ck, new RegionGraph(rom, capabilities(ctx))).get(ck)!;
    alt.setSwitch(!on);
    const bAt = atMap !== undefined && at ? alt.regionAt(atMap, at.x, at.y) : null;
    const { da, db } = switchDistances(rom, rg, alt, objRegions, bAt ? [bAt] : objMaps.flatMap((id) => alt.regionsOf(id)), skip);
    dist = da;
    hereHops = inObjective(gs.mapId, [hereRegion]) ? 0 : (hereRegion ? dist.get(hereRegion) : undefined) ?? Infinity;
    switchAfter = { alt, db };
  }
  // blocked only by how this map is right now (gates that switches open and close): give the layout's route anyway
  mem.gatedRoute = false;
  if (!isFinite(hereHops) && objMaps.length) {
    rg.refine(gs.mapId, new Set(), undefined, 'layout');
    const lRegion = atMap !== undefined && at ? rg.regionAt(atMap, at.x, at.y) : null;
    const lObj = lRegion ? [lRegion] : objMaps.flatMap((id) => rg.regionsOf(id));
    const lDist = rg.distancesTo(lObj, skip);
    const lHere = rg.regionAt(gs.mapId, px, py);
    const lHops = (lRegion ? lHere === lRegion : objMaps.includes(gs.mapId)) ? 0 : (lHere ? lDist.get(lHere) : undefined) ?? Infinity;
    if (isFinite(lHops)) { atRegion = lRegion; objRegions = lObj; dist = lDist; hereRegion = lHere; hereHops = lHops; mem.gatedRoute = true; }
  }
  // unreachable as things are: would a field move nobody knows yet (CUT / SURF) open the way? (a fact for Jev)
  mem.fieldMoveNeeded = undefined;
  mem.subObjective = undefined;
  if (!isFinite(hereHops) && objMaps.length) {
    const caps = capabilities(ctx);
    for (const mv of ['CUT', 'SURF'] as const) {
      const k = mv === 'CUT' ? 'cut' : 'surf';
      if (caps[k]) continue;
      const c2 = { ...caps, [k]: true };
      const ck = `${c2.cut}|${c2.surf}`;
      const alt = hypoGraphs.get(ck) ?? hypoGraphs.set(ck, new RegionGraph(rom, c2)).get(ck)!;
      const aAt = atMap !== undefined && at ? alt.regionAt(atMap, at.x, at.y) : null;
      const d = alt.distancesTo(aAt ? [aAt] : objMaps.flatMap((id) => alt.regionsOf(id)), new Set());
      const hr = alt.regionAt(gs.mapId, px, py);
      if (hr && d.has(hr)) { mem.fieldMoveNeeded = mv; break; }
    }
    // Like an item prerequisite ("get X first, found at Y"): when the PC box holds a Pokémon that can learn the
    // missing field move (now, or after evolving with an item already in the bag), the objective's first step is a
    // team member that knows it, and where that happens is a Pokémon Center (its PC). How is up to Jev.
    if (mem.fieldMoveNeeded) {
      const l = fieldMoveLearners(ctx, mem.fieldMoveNeeded);
      const inBox = l.box.length > 0 || l.afterEvolving.some((t) => t.startsWith('in the PC box') && /one is in the bag/.test(t));
      const inParty = l.party.length > 0 || l.afterEvolving.some((t) => t.startsWith('in the party') && !/none in the bag/.test(t));
      // a team member can already get there (learn it now, or evolve with an item in the bag): no PC trip needed
      // stalled for 45+ minutes: go by the way that takes the fewest levels + actions (a PC trip if that's the box)
      const stalled = Date.now() - (mem.subSince ?? Date.now()) > 45 * 60_000;
      const best = [...l.costs].sort((a, b) => a.cost - b.cost)[0];
      const boxFastest = stalled && !l.party.length && !!best?.inBox;
      if (inParty && !boxFastest) mem.subObjective = `a team Pokémon that knows ${mem.fieldMoveNeeded} (a team member can ${l.party.length ? 'learn it' : 'learn it after evolving'})`;
      else if (inBox) {
        mem.subObjective = `a team Pokémon that knows ${mem.fieldMoveNeeded} (the PC box at any Pokémon Center holds Pokémon that can learn it)`;
        objMapsNow = [...rom.maps.values()].filter((mm) => PC_MAPS.test(mm.name)).map((mm) => mm.id);
        atRegion = null;
        objRegions = objMapsNow.flatMap((id) => rg.regionsOf(id));
        dist = rg.distancesTo(objRegions, skip);
        hereHops = inObjective(gs.mapId, [hereRegion]) ? 0 : (hereRegion ? dist.get(hereRegion) : undefined) ?? Infinity;
      }
    }
  }
  // track how long a field-move prerequisite has been unmet
  if (mem.fieldMoveNeeded) mem.subSince ??= Date.now(); else mem.subSince = undefined;
  // did the last switch press here open the way? (still closed afterwards = it didn't)
  if (mem.switchPressedOn === gs.mapName) {
    mem.switchNoEffect ??= {};
    mem.switchNoEffect[gs.mapName] = mem.gatedRoute ? (mem.switchNoEffect[gs.mapName] ?? 0) + 1 : 0;
    mem.switchPressedOn = undefined;
  }
  if (!mem.gatedRoute && mem.switchNoEffect?.[gs.mapName]) mem.switchNoEffect[gs.mapName] = 0;
  lastObjectiveDist = { dist, rg, objMaps: objMapsNow, atRegion };
  lastObjectiveReachable = isFinite(hereHops);
  lastHereHops = hereHops;
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
    const gate = mem.gatedRoute ? ' (by the map layout; a gate on the way is closed right now)' : '';
    if (h < hereHops) return `Leads toward the objective (${h} area(s) away from it)${gate}.`;
    // switch-gated buildings: gates move with every press, so no 'away'/'same' claims from the layout there
    if (mem.gatedRoute && SWITCH_GATES.some((x) => x.map === gs.mapName)) return '';
    if (h > hereHops) return `Leads away from the objective (${h} areas away)${gate}.`;
    return `Same distance from the objective (${h} areas)${gate}.`;
  };
  // distances to services (nearest Pokémon Center / Mart), for healing and shopping intents
  const serviceDist = (re: RegExp) => {
    const ids = Object.entries((gen as any).maps).filter(([, v]: any) => re.test(v.name)).map(([id]) => +id);
    // in a switch-gated building, the way out may need a switch press too
    if (switchAfter) {
      const r = switchDistances(rom, rg, switchAfter.alt, ids.flatMap((id) => rg.regionsOf(id)), ids.flatMap((id) => switchAfter!.alt.regionsOf(id)), skip);
      switchSvc[re.source] = r;
      return r.da;
    }
    return rg.distancesTo(ids.flatMap((id) => rg.regionsOf(id)), skip);
  };
  const pcDist = serviceDist(PC_MAPS), martDist = serviceDist(MART_MAPS);
  lastServiceDist = { pc: pcDist, mart: martDist };
  const hereReg = hereRegion ? [hereRegion] : [];
  // the "by layout" view treats other floors' boulders as floor, which can fake a way to a Pokémon Center through
  // them: in that view, no Pokémon Center / Mart claims for destinations on floors that have boulders
  const hasBoulders = (mapId: number) => !!rom.maps.get(mapId)?.objects.some((o) => SPRITES[o.sprite] === 'BOULDER');
  const svc = (regions0: string[]) => {
    const regions = mem.gatedRoute ? regions0.filter((r) => !hasBoulders(+r.split(':')[0])) : regions0;
    if (!regions.length) return '';
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
    const wl = rom.wildLevels(dest);
    return (n ? `Visited ${n} time(s) before.` : 'Unvisited place.') + (wl ? ` Wild Pokémon appear there (Lv${wl.min}-${wl.max}).` : '');
  };

  const out: Candidate[] = [];
  const add = (key: string, desc: string, target: Target, path: Step[] | null) => {
    if (!path) return;
    // walking for wild encounters is meant to be repeated: no 'chosen N times' count on it
    const n = target.kind === 'grass' ? 0 : used(key);
    const blockedN = mem.blockedExits?.[`${gs.mapName}:${key}`] ?? 0;
    // stopped 5+ times: a dead end for now, not offered until a badge, the objective or the bag changes
    if (blockedN >= 5) return;
    const stopSaid = mem.npcText[`${gs.mapName}:${key}:blocked`];
    const blockedNote = blockedN ? ` Tried ${blockedN} time(s) before and did NOT get through (something stopped you / sent you back).${stopSaid ? ` What was said when you were stopped: "${clip(stopSaid)}".` : ''}` : '';
    out.push({ key, target, path, desc: `${desc} ${path.length} steps away.${n ? ` Chosen ${n} time(s) already on this visit.` : ''}${blockedNote}` });
  };

  // exits that can't be reached on foot right now (SURF options report which of these they open up)
  const offFoot: { x: number; y: number; dest: number; regions: string[] }[] = [];
  // Warps (dedupe adjacent warps with the same destination)
  const seenWarp: { dest: number; land: Set<string>; c: Candidate }[] = [];
  const blockers = new Map<number, string>(); // sprite index -> fact
  const lastMap = gs.u8('wLastMap');
  (md?.warps ?? []).forEach((w, wi) => {
    // someone or a boulder stands on the door square itself: it can't be used right now (a twin door may be free)
    if (occupied.has(`${w.x},${w.y}`)) return;
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
    // doors side by side (a 2-wide gate) land on different squares but in the same area: same place
    const land = new Set(destRegions.flatMap((r) => rg.landing(r)));
    const blockedExceptThis = new Set(blocked); blockedExceptThis.delete(`${w.x},${w.y}`);
    const path = px === w.x && py === w.y ? [] : findPath(g, px, py, (x, y) => x === w.x && y === w.y, { blocked: blockedExceptThis, surf });
    // exit only unreachable because a person stands in the way → record that as a plain fact on that person
    if (!path) {
      if (!surf && destRegions.length) offFoot.push({ x: w.x, y: w.y, dest, regions: destRegions });
      const free = new Set(warpSquares); free.delete(`${w.x},${w.y}`);
      const open = findPath(g, px, py, (x, y) => x === w.x && y === w.y, { blocked: free, surf });
      // Which single person, if they weren't standing there, would open the way? (test each one on the route)
      const people = gs.sprites().filter((sp) => !sp.hidden && open?.some((st) => st.x === sp.x && st.y === sp.y));
      const openers = people.filter((sp) => {
        const without = new Set(blocked); without.delete(`${sp.x},${sp.y}`); without.delete(`${w.x},${w.y}`);
        return !!findPath(g, px, py, (x, y) => x === w.x && y === w.y, { blocked: without, surf });
      });
      // a boulder in the way: does any single push (to open floor) actually clear that path?
      const pushClears = (sp: { x: number; y: number }) => Object.values(DIRS).some(([dx, dy]) => {
        const tx = sp.x + dx, ty = sp.y + dy, sx = sp.x - dx, sy = sp.y - dy;
        if (!g.walkable(sx, sy) || !boulderCanGo(sx, sy, tx, ty) || blocked.has(`${tx},${ty}`) || (tx === px && ty === py)) return false;
        // the player has to be able to get behind it
        if (!(sx === px && sy === py) && !findPath(g, px, py, (x, y) => x === sx && y === sy, { blocked, surf, maxNodes: 4000 })) return false;
        const moved = new Set(blocked); moved.delete(`${sp.x},${sp.y}`); moved.delete(`${w.x},${w.y}`); moved.add(`${tx},${ty}`);
        return !!findPath(g, px, py, (x, y) => x === w.x && y === w.y, { blocked: moved, surf });
      });
      for (const sp of openers) {
        const boulderNote = SPRITES[sp.picture] === 'BOULDER' && !pushClears(sp) ? ' No single push clears that path: wherever it is pushed, it still blocks the way.' : '';
        blockers.set(sp.index, `Standing in the only path to the exit at (${w.x},${w.y}) to ${mapName(dest)}.${boulderNote} That exit: ${routeFacts(dest, destRegions)}`);
      }
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
    const prevE = seenWarp.find((e) => e.dest === dest && (land.size === 0 ? e.land.size === 0 : [...land].some((r) => e.land.has(r))));
    const prev = prevE?.c;
    if (prev && prev.path.length <= path.length) return;
    if (prevE) { out.splice(out.indexOf(prevE.c), 1); seenWarp.splice(seenWarp.indexOf(prevE), 1); }
    const name = mapName(dest);
    const heal = PC_MAPS.test(name) ? ' A Pokémon Center: the nurse heals the whole party for free. Healing here also makes it where you return if all your Pokémon faint.' : /MART/.test(name) ? ' A Poké Mart: buy items.' : /GYM/.test(name) ? ' A Pokémon Gym.' : '';
    destRegionsByKey.set(`w:${w.x},${w.y}`, destRegions);
    add(`Enter ${name}`, `Door/stairs/ladder at (${w.x},${w.y}) leading to ${name}.${heal} ${routeFacts(dest, destRegions)}${svc(destRegions)} ${visitFacts(dest)}${leaveNote}`, { kind: 'warp', x: w.x, y: w.y, dest }, path);
    seenWarp.push({ dest, land, c: out[out.length - 1] });
  });

  // Holes in the floor: stepping on one drops you to another floor
  for (const h of HOLES.filter((hh) => hh.from === gs.mapName)) {
    const to = [...rom.maps.values()].find((mm) => mm.name === h.to);
    if (!to) continue;
    const tr = rg.regionAt(to.id, h.tx, h.ty);
    const blockedExceptThis = new Set(blocked); blockedExceptThis.delete(`${h.x},${h.y}`);
    const path = px === h.x && py === h.y ? [] : findPath(g, px, py, (x, y) => x === h.x && y === h.y, { blocked: blockedExceptThis, surf });
    destRegionsByKey.set(`w:${h.x},${h.y}`, tr ? [tr] : []);
    add(`Drop through the hole at (${h.x},${h.y})`, `A hole in the floor: stepping on it drops you down to ${h.to}. ${routeFacts(to.id, tr ? [tr] : [])} ${visitFacts(to.id)}`, { kind: 'warp', x: h.x, y: h.y, dest: to.id }, path);
  }

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
    // walking (not surfing) can't step from land onto water across the edge either
    const exitGoal = (x: number, y: number) => {
      if (!allowExit(x, y) || !landsOk(x, y)) return false;
      const ix = Math.min(Math.max(x, 0), g.w - 1), iy = Math.min(Math.max(y, 0), g.h - 1);
      return !(md && !g.water(ix, iy) && rg.landsOnWater(md, c, ix, iy));
    };
    const path2 = findPath(g, px, py, exitGoal, { blocked, allowExit: exitGoal, grassCost: 1, surf });
    const inside = path2 && path2.length ? (path2.length > 1 ? path2[path2.length - 2] : { x: px, y: py }) : null;
    const destRegion = inside && md ? rg.connectionTarget(md, c, inside.x, inside.y) : null;
    destRegionsByKey.set(`e:${dir}`, destRegion ? [destRegion] : []);
    add(`Go ${c.dir} to ${name}`, `Walk off the ${c.dir} edge of the map into ${name}. ${routeFacts(c.map, destRegion ? [destRegion] : [])}${svc(destRegion ? [destRegion] : [])} ${visitFacts(c.map)}${leaveNote}`, { kind: 'exit', dir, dest: c.map }, path2);
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
    const ballName = obj?.item != null ? rom.items.get(obj.item) : undefined;
    const bagFullNote = ballName && gs.bag().length >= 20 && !gs.bag().some((i) => i.name === ballName) ? ' The bag is full (20 of 20 item slots): picking it up fails until a slot is freed (toss, sell or store an item).' : '';
    // named people from the objective text (e.g. MR_FUJI ~ "Mr. Fuji", GIOVANNI, BILL)
    const letters = (t: string) => t.toUpperCase().replace(/[^A-Z]/g, '');
    const inGoal = spriteName.length > 3 && !/^(ROCKET|GIRL|BOY|GUARD|NURSE|CLERK|SUPER_NERD|YOUNGSTER|LASS)$/.test(spriteName) && letters(m?.goal ?? '').includes(letters(spriteName)) ? ' Mentioned in the current objective.' : '';
    // the objective's own spot (e.g. the item the objective names): say so
    const isGoalSpot = !!at && at.map === gs.mapName && at.x === sp.x && at.y === sp.y ? ' The objective is in this place: this is what the current objective is about.' : '';
    const facts = `${kind} at (${sp.x},${sp.y}).${isGoalSpot}${bagFullNote}${inGoal}${said ? ` Last time they said: "${clip(said)}".` : ' Not yet talked to.'}${spriteName === 'NURSE' ? ' Heals the whole party.' : ''}${spriteName === 'CLERK' ? ' Shop clerk: buy items.' : ''}`;
    if (spriteName === 'BOULDER' && said && gs.u8('wStatusFlags1') & 1) continue;
    const label = obj?.item != null ? `Pick up item ball at (${sp.x},${sp.y})` : OBJECTS[spriteName] ? `Examine the ${spriteName.toLowerCase().replace(/_/g, ' ')} at (${sp.x},${sp.y})` : `Talk to ${obj?.trainer ? who : spriteName} at (${sp.x},${sp.y})`;
    add(label, blockers.has(sp.index) ? `${facts} ${blockers.get(sp.index)}` : facts, { kind: 'npc', index: sp.index, x: sp.x, y: sp.y, sprite: spriteName }, path);
  }

  // Signs
  for (const sg of md?.signs ?? []) {
    const sgGoal = interactGoal(g, sg.x, sg.y);
    const path = sgGoal(px, py) ? [] : findPath(g, px, py, sgGoal, { blocked, maxNodes: 6000 });
    const k = `${gs.mapName}:sign${sg.x},${sg.y}`;
    const said = mem.npcText[k];
    if (gs.mapName === 'CELADON_MART_ROOF' && sg.y <= 2 && sg.x >= 10 && sg.x <= 12) add(`Use the vending machine at (${sg.x},${sg.y})`, `A drink vending machine (FRESH WATER ¥200, SODA POP ¥300, LEMONADE ¥350).${said ? ` Last time: "${clip(said)}".` : ''}`, { kind: 'sign', x: sg.x, y: sg.y }, path);
    else if (/ELEVATOR/.test(gs.mapName)) {
      // which floors it serves, and how far each is from the objective
      const floors = [...rom.maps.values()].filter((mm) => mm.warps.some((w) => w.destMap === gs.mapId)).map((mm) => {
        const h = hopsFromMap(mm.id, gs.mapId);
        const pc = /POKECENTER/.test(serviceFactsFromMap(mm.id, gs.mapId)) ? ', toward the nearest Pokémon Center' : '';
        return `${mm.name.replace(/^.*_/, '')}${h !== undefined ? ` (${h} areas from the objective${pc})` : pc ? ` (${pc.slice(2)})` : ''}`;
      });
      add(`Use the elevator panel at (${sg.x},${sg.y})`, `The elevator's floor-select panel: choose which floor the doors lead to. Floors: ${floors.join(', ')}.${said ? ` Last time it said: "${clip(said)}".` : ''}`, { kind: 'sign', x: sg.x, y: sg.y }, path);
    }
    else add(`Read sign at (${sg.x},${sg.y})`, said ? `A sign. It says: "${said.slice(0, 300)}".` : 'A sign, not yet read.', { kind: 'sign', x: sg.x, y: sg.y }, path);
  }

  // Hidden interactables (PCs, switches, statues, trash cans...). Hidden items are excluded: a human wouldn't know them.
  const HIDDEN_LABEL: [RegExp, string][] = [[/PokemonCenterPC|RedsPC|BillsHousePC/, 'Use the PC'], [/Switches/, 'Press the switch'], [/GymTrash/, 'Search the trash can'], [/GymStatues/, 'Read the gym statue'], [/CinnabarQuiz/, 'Use the quiz machine'], [/Fossil/, 'Examine the fossil'], [/Binoculars/, 'Look through binoculars']];
  for (const h of rom.hidden.get(gs.mapId) ?? []) {
    if (/HiddenItems|HiddenCoins|StartSlotMachine|CableClub/.test(h.fn)) continue;
    // these only respond when the player faces up at them (the game checks the facing direction)
    const UP_ONLY = /Quiz|GymStatues|Binoculars|PokemonCenterPC|BillsHousePC|OakLabEmail|IndigoPlateauHQ/;
    const face = UP_ONLY.test(h.fn) ? 4 : [0, 4, 8, 0xc].includes(h.arg) && /PC|Switches/.test(h.fn) ? h.arg : null;
    const standOk = (x: number, y: number) => {
      if (face === null) return adj(x, y, h.x, h.y);
      const [dx, dy] = face === 4 ? [0, 1] : face === 0 ? [0, -1] : face === 8 ? [1, 0] : [-1, 0];
      return x === h.x + dx && y === h.y + dy;
    };
    const path = standOk(px, py) ? [] : findPath(g, px, py, standOk, { blocked, maxNodes: 6000 });
    const label = HIDDEN_LABEL.find(([re]) => re.test(h.fn))?.[1] ?? `Examine ${h.fn.replace(/^(Print|Display)/, '').replace(/Text$/, '').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()}`;
    const k = `${gs.mapName}:hidden${h.x},${h.y}`;
    const said = mem.npcText[k];
    const pcObj = mem.subObjective?.includes('the PC box') && label === 'Use the PC' ? ' Mentioned in the current objective (the PC box).' : '';
    const noEff = mem.switchNoEffect?.[gs.mapName] ?? 0;
    // pressing it flips every gate: where would the objective be from here then?
    let flipFact = '';
    if (label === 'Press the switch' && switchAfter) {
      const r = switchAfter.alt.regionAt(gs.mapId, h.x, h.y + 1);
      const after = r ? switchAfter.db.get(r) : undefined;
      // and toward the nearest Pokémon Center / Mart after the flip?
      const svcAfter = (src: string, label: string) => {
        const sv = switchSvc[src]; if (!sv || !r) return '';
        const now = hereRegion ? sv.da.get(hereRegion) : undefined, then = sv.db.get(r);
        return then !== undefined && (now === undefined || then < now) ? ` After pressing it: toward the nearest ${label} (${then} areas).` : '';
      };
      const svcNote = svcAfter(PC_MAPS.source, 'Pokémon Center') + svcAfter(MART_MAPS.source, 'Poké Mart');
      // compare with NOT pressing, standing at the same switch (walking there can already change the distance)
      const ra = rg.regionAt(gs.mapId, h.x, h.y + 1);
      const without = ra ? (inObjective(gs.mapId, [ra]) ? 0 : dist.get(ra)) : undefined;
      const nowTxt = without !== undefined ? `${without} without pressing` : 'not reachable without pressing';
      flipFact = svcNote + (after === undefined ? ' After pressing it (all gates flip), the objective would not be reachable from here.'
        : without === undefined || after < without ? ` Pressing it leads toward the objective: all gates flip, and the objective is then ${after} area(s) away (${nowTxt}).`
        : ` Pressing it flips all gates; the objective is then ${after} area(s) away (${nowTxt}), so pressing doesn't bring it closer.`);
    }
    const sw = label === 'Press the switch' ? ` Switches in this building open some gates and close others.${!mem.gatedRoute ? '' : noEff ? ` The way to the objective is closed by a gate right now, and it was still closed after pressing a switch here ${noEff} time(s) (each press flips the same gates back and forth).` : ' The way to the objective is closed by a gate right now; this switch changes which gates are closed.'}` : '';
    add(`${label} at (${h.x},${h.y})`, (said ? `Examined before: "${clip(said)}".` : 'Not examined yet.') + pcObj + (flipFact || sw), { kind: 'hidden', x: h.x, y: h.y, face }, path);
  }

  // Silph Co. card-key doors: facing the door tile and pressing A opens it if the CARD KEY is in the bag
  if (/^SILPH_CO_([2-9]|1[01])F$/.test(gs.mapName)) {
    const doorTile = (x: number, y: number) => cardKeyDoor(gs, g, x, y);
    const hasKey = hasCardKey(gs);
    // squares reachable from here right now (doors closed, people ignored)
    const flood = (sx: number, sy: number) => {
      const seen = new Set<string>([`${sx},${sy}`]); const q = [[sx, sy]];
      while (q.length) { const [cx, cy] = q.pop()!; for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) { const nx = cx + dx, ny = cy + dy, k = `${nx},${ny}`; if (!seen.has(k) && g.walkable(nx, ny) && !doorTile(nx, ny)) { seen.add(k); q.push([nx, ny]); } } }
      return seen;
    };
    const reach = flood(px, py);
    const atHere = at && at.map === gs.mapName ? at : undefined;
    const best = new Map<string, { x: number; y: number; path: Step[] | null; behind: string }>();
    for (let y = 0; y < g.h; y++) for (let x = 0; x < g.w; x++) {
      if (!doorTile(x, y)) continue;
      const goal = (sx: number, sy: number) => adj(sx, sy, x, y) && !doorTile(sx, sy);
      const path = goal(px, py) ? [] : findPath(g, px, py, goal, { blocked, maxNodes: 4000 });
      if (!path) continue;
      // what's on the other side: floor next to the door that can't be reached from here now
      let behind = '';
      for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0], [0, 2], [0, -2], [2, 0], [-2, 0]]) {
        const nx = x + dx, ny = y + dy;
        if (!g.walkable(nx, ny) || doorTile(nx, ny) || reach.has(`${nx},${ny}`)) continue;
        const other = flood(nx, ny);
        behind = atHere && other.has(`${atHere.x},${atHere.y}`) ? ' The objective location is behind this door.' : ' Behind it is an area not reachable from here otherwise.';
        break;
      }
      const k = `${x >> 1},${y >> 1}`;
      const prev = best.get(k);
      if (!prev || (prev.path?.length ?? 1e9) > path.length) best.set(k, { x, y, path, behind });
    }
    for (const d of best.values()) {
      add(`Open the locked door at (${d.x},${d.y})`, `A locked Silph Co. door; the CARD KEY opens it (${hasKey ? 'the CARD KEY is in the bag' : 'no CARD KEY in the bag'}).${d.behind}`, { kind: 'hidden', x: d.x, y: d.y, face: null }, d.path);
    }
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
      // exits that can't be reached on foot but can from this water
      const opens = offFoot.filter((e) => {
        const b = new Set(blocked); b.delete(`${e.x},${e.y}`); // the exit square itself is the goal
        return findPath(g, x, y, (ex, ey) => ex === e.x && ey === e.y, { blocked: b, surf: true, resurf: true, maxNodes: 8000 });
      });
      const names = [...new Set(opens.map((e) => mapName(e.dest)))];
      const opensRegions = opens.flatMap((e) => e.regions);
      const opensNote = names.length ? ` From this water you can reach exits not reachable on foot: ${names.join(', ')}. ${routeFacts(opens[0].dest, opensRegions)}${svc(opensRegions)}` : ` ${routeFacts(gs.mapId, [r])}`;
      add(`SURF onto the water at (${x},${y})`, `Start surfing on this water.${opensNote}`, { kind: 'surf', x, y }, path);
    }
  }
  const boulders = gs.sprites().filter((s) => !s.hidden && SPRITES[s.picture] === 'BOULDER');
  // exit mats that only warp when facing/walking toward the map edge (the game's ExtraWarpCheck, facing-edge variant):
  // square -> the directions that would warp
  const edgeMats = new Map<string, Dir[]>();
  if (md && boulders.length && ![0, 13, 14, 23].includes(md.tileset) && !/^(ROCKET_HIDEOUT_B[124]F|ROCK_TUNNEL_1F)$/.test(gs.mapName)) {
    const stepTiles = rom.stepWarpTiles(md.tileset);
    for (const w of md.warps) {
      if (stepTiles.has(g.tile(w.x, w.y))) continue;
      const dirs: Dir[] = [];
      if (w.x === 0) dirs.push('left'); if (w.x === g.w - 1) dirs.push('right');
      if (w.y === 0) dirs.push('up'); if (w.y === g.h - 1) dirs.push('down');
      if (dirs.length) edgeMats.set(`${w.x},${w.y}`, dirs);
    }
  }
  if (boulders.length && slotWithMove(ctx, 'STRENGTH') >= 0 && gs.badges & 0x08) {
    // search over (boulder square, where the player can walk) for a push sequence that lands the boulder on a switch
    // fewest pushes to get this boulder onto a switch (Infinity = impossible, NaN = search too big to tell)
    const switchPushes = (b: { x: number; y: number }, bx0: number, by0: number, px0: number, py0: number, sws: { x: number; y: number }[]): number => {
      const base = new Set([...blocked].filter((k) => k !== `${b.x},${b.y}` && !edgeMats.has(k)));
      const free = (x: number, y: number) => g.walkable(x, y) && !base.has(`${x},${y}`);
      const region = (bx: number, by: number, sx: number, sy: number) => {
        const seen = new Set([`${sx},${sy}`]), q = [[sx, sy]];
        while (q.length) {
          const [x, y] = q.pop()!;
          for (const [ex, ey] of Object.values(DIRS)) {
            const nx = x + ex, ny = y + ey, k = `${nx},${ny}`;
            if (seen.has(k) || (nx === bx && ny === by) || !free(nx, ny)) continue;
            seen.add(k); q.push([nx, ny]);
          }
        }
        return seen;
      };
      const visited = new Set<string>();
      const queue: [number, number, number, number, number][] = [[bx0, by0, px0, py0, 0]];
      while (queue.length && visited.size < 4000) {
        const [bx, by, sx, sy, n] = queue.shift()!;
        if (sws.some((f) => f.x === bx && f.y === by)) return n;
        const reach = region(bx, by, sx, sy);
        const sig = `${bx},${by}|${[...reach].sort()[0]}`;
        if (visited.has(sig)) continue;
        visited.add(sig);
        for (const [ex, ey] of Object.values(DIRS)) {
          if (!reach.has(`${bx - ex},${by - ey}`) || !free(bx + ex, by + ey) || !boulderCanGo(bx - ex, by - ey, bx + ex, by + ey)) continue;
          queue.push([bx + ex, by + ey, bx, by, n + 1]);
        }
      }
      return visited.size >= 4000 ? NaN : Infinity; // search too big: unknown
    };
    const switchReachable = (b: { x: number; y: number }, bx0: number, by0: number, px0: number, py0: number, sws: { x: number; y: number }[]) => {
      const n = switchPushes(b, bx0, by0, px0, py0, sws);
      return isNaN(n) || isFinite(n);
    };
    const freeSwitches = openTargets(gs, boulders);
    const reachNow = new Map<number, boolean>();
    const canReachNow = (b: { index: number; x: number; y: number }) => {
      if (!reachNow.has(b.index)) reachNow.set(b.index, switchReachable(b, b.x, b.y, px, py, freeSwitches));
      return reachNow.get(b.index)!;
    };
    // squares the player can walk to, and whether moving this boulder lets them reach a door they can't reach now
    const walkSet = (blk: Set<string>) => {
      const seen = new Set([`${px},${py}`]), q = [[px, py]];
      while (q.length) {
        const [x, y] = q.pop()!;
        for (const [ex, ey] of Object.values(DIRS)) {
          const nx = x + ex, ny = y + ey, k = `${nx},${ny}`;
          if (seen.has(k) || !g.walkable(nx, ny) || blk.has(k)) continue;
          seen.add(k); q.push([nx, ny]);
        }
      }
      return seen;
    };
    const doorsReached = (sq: Set<string>) => new Set((md?.warps ?? []).filter((w) => Object.values(DIRS).some(([ex, ey]) => sq.has(`${w.x + ex},${w.y + ey}`))).map((w) => `${w.x},${w.y}`));
    const doorsNow = doorsReached(walkSet(blocked));
    const opensWay = (b: { x: number; y: number }, tx: number, ty: number) => {
      const moved = new Set(blocked); moved.delete(`${b.x},${b.y}`); moved.add(`${tx},${ty}`);
      return [...doorsReached(walkSet(moved))].some((k) => !doorsNow.has(k));
    };
    const swFree = freeSwitches.length > 0;
    const gateNote = mem.gatedRoute && swFree ? ' The way to the objective is closed by a gate right now; a boulder on a floor switch (or dropped through a hole in the floor) opens it.' : '';
    if (!(gs.u8('wStatusFlags1') & 1)) add('Activate STRENGTH', `Lets the player push boulders on this map.${gateNote}`, { kind: 'strength' }, []);
    else for (const b of boulders) for (const d of Object.keys(DIRS) as Dir[]) {
      const [dx, dy] = DIRS[d];
      const sx = b.x - dx, sy = b.y - dy, tx = b.x + dx, ty = b.y + dy;
      if (!g.walkable(sx, sy) || !boulderCanGo(sx, sy, tx, ty) || blocked.has(`${tx},${ty}`)) continue;
      // exit mats on the map edge only warp when walking toward the edge: they can be stood on to push
      const standBlocked = new Set(blocked); for (const k of edgeMats.keys()) standBlocked.delete(k);
      const noEnter = (x: number, y: number, dd: Dir) => edgeMats.get(`${x},${y}`)?.includes(dd) ?? false;
      const path = sx === px && sy === py ? [] : findPath(g, px, py, (x, y) => x === sx && y === sy, { blocked: standBlocked, noEnter, maxNodes: 6000 });
      // plain facts about the result of this push (switches/holes are visible floor features in the game)
      const feature = FLOOR_FEATURES[gs.mapName]?.find((f) => f.x === tx && f.y === ty);
      // edge exit mats can be stood on to push (see edgeMats)
      const others = new Set([...blocked].filter((k) => k !== `${b.x},${b.y}` && !edgeMats.has(k)));
      const pushable = (Object.keys(DIRS) as Dir[]).filter((d2) => {
        const [ex, ey] = DIRS[d2];
        const k1 = `${tx - ex},${ty - ey}`, k2 = `${tx + ex},${ty + ey}`;
        return g.walkable(tx - ex, ty - ey) && boulderCanGo(tx - ex, ty - ey, tx + ex, ty + ey) && !others.has(k1) && !others.has(k2);
      });
      // the floor switches are visible on screen: how far this boulder would be from the nearest free one
      const freeSw = openTargets(gs, boulders);
      // distance over open floor (walls count; other boulders block), not a straight line
      const near = (x0: number, y0: number) => {
        const seen = new Set([`${x0},${y0}`]); let front = [[x0, y0]], d = 0;
        while (front.length && d < 200) {
          if (front.some(([x, y]) => freeSw.some((f) => f.x === x && f.y === y))) return d;
          const next: number[][] = [];
          for (const [x, y] of front) for (const [ex, ey] of Object.values(DIRS)) {
            const nx = x + ex, ny = y + ey, k = `${nx},${ny}`;
            if (seen.has(k) || !g.walkable(nx, ny) || boulders.some((o) => o !== b && o.x === nx && o.y === ny)) continue;
            seen.add(k); next.push([nx, ny]);
          }
          front = next; d++;
        }
        return Infinity;
      };
      const dTxt = (v: number) => (isFinite(v) ? `${v} squares` : 'no open floor path');
      // a boulder closer to a switch than ever on this visit is puzzle progress (the loop guard reads it)
      const nowD = near(b.x, b.y), vk = `${gs.mapName}#${mem.visitedMaps[gs.mapName] ?? 0}:${b.index}`; // per boulder, per visit
      const prevD = mem.boulderBest?.[vk];
      if (isFinite(nowD) && nowD < (prevD ?? Infinity)) {
        (mem.boulderBest ??= {})[vk] = nowD;
        if (prevD !== undefined) mem.boulderGains = (mem.boulderGains ?? 0) + 1; // the first reading on a visit isn't progress
      }
      // can any sequence of pushes still bring this boulder onto a free floor switch after this push?
      const onTarget = !!feature && freeSw.includes(feature);
      const lost = freeSw.length > 0 && !onTarget && !switchReachable(b, tx, ty, b.x, b.y, freeSw);
      // fewer pushes still needed after this push than now (walking distance can mislead: a wall may be behind it)
      const closerByPushes = () => {
        const after = switchPushes(b, tx, ty, b.x, b.y, freeSw), now = switchPushes(b, b.x, b.y, px, py, freeSw);
        return isFinite(after) && isFinite(now) && after < now;
      };
      const sw = freeSw.length && !onTarget
        ? `${freeSw.map((f) => `${f.kind === 'switch' ? 'Floor switch' : 'Hole in the floor'} at (${f.x},${f.y})`).join(', ')}: the boulder would be ${dTxt(near(tx, ty))} from the nearest over open floor (now ${dTxt(near(b.x, b.y))}).` : '';
      // what sets the pushes apart comes first; the gate note is on "Activate STRENGTH" and the reset note on the exits
      const facts = [
        `Moves the boulder one square ${d} to (${tx},${ty}).`,
        feature ? `That square is a ${feature.kind === 'switch' ? 'floor switch' : 'hole in the floor'}.` : '',
        // closer to the switch without stranding the boulder: toward the objective (same idea as "Pressing it leads toward the objective")
        mem.gatedRoute && freeSw.length && !feature && pushable.length > 0 && !lost && closerByPushes() ? 'Leads toward the objective: brings the boulder closer to a floor switch / hole.' : '',
        feature && freeSw.includes(feature) && mem.gatedRoute ? `Leads toward the objective: ${feature.kind === 'switch' ? 'puts the boulder on the floor switch' : 'drops the boulder through the hole'}.` : '',
        !feature && pushable.length === 0 ? 'After this push the boulder cannot be pushed from any side.' : '',
        !feature && pushable.length > 0 && lost ? 'After this push no sequence of pushes can bring this boulder onto a floor switch / into a hole anymore.' : '',
        mem.stuckPushes?.[`${gs.mapName}:Push boulder at (${b.x},${b.y}) ${d}`] ? `Made ${mem.stuckPushes[`${gs.mapName}:Push boulder at (${b.x},${b.y}) ${d}`]} time(s) in earlier attempts; each time the boulder was stuck afterwards.` : '',
        sw,
      ].filter(Boolean).join(' ');
      // a push that leaves the boulder unmovable, or strands one that could still reach a switch, and opens no new
      // way out, isn't offered
      // (it can only be undone by leaving the floor; same rule as other options that can't lead anywhere)
      if (freeSw.length && !feature && (pushable.length === 0 || (lost && canReachNow(b))) && !opensWay(b, tx, ty)) continue;
      add(`Push boulder at (${b.x},${b.y}) ${d}`, facts, { kind: 'push', x: b.x, y: b.y, dir: d }, path);
    }
    // when a boulder has pushes that lead toward a switch, its other pushes (away / sideways) aren't offered,
    // unless they open a new way out; Jev still picks which boulder and which of the toward pushes
    for (const b of boulders) {
      const mine = out.filter((c) => c.target.kind === 'push' && c.target.x === b.x && c.target.y === b.y);
      if (!mine.some((c) => /Leads toward the objective/.test(c.desc))) continue;
      for (const c of mine) {
        if (/Leads toward the objective/.test(c.desc) || c.target.kind !== 'push') continue;
        const [dx, dy] = DIRS[c.target.dir];
        if (opensWay(b, b.x + dx, b.y + dy)) continue;
        out.splice(out.indexOf(c), 1);
      }
    }
    // no boulder can reach a free switch from where it is now: say so on the exits (leaving resets them)
    const freeAll = openTargets(gs, boulders);
    if (movedBoulder && mem.gatedRoute && freeAll.length && !boulders.some((b) => switchReachable(b, b.x, b.y, px, py, freeAll))) {
      for (const c of out) if (c.target.kind === 'warp' || c.target.kind === 'exit') c.desc = c.desc.replace(leaveNote, ` Right now no boulder on this floor can be brought onto a floor switch / into a hole from where it is.${leaveNote}`);
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
    else if (/RARE CANDY/.test(it.name)) {
      const low = [...party].sort((a, b) => a.level - b.level)[0];
      desc = `You have ${it.qty}. Each one raises one Pokémon by one level (for example ${low?.nickname} Lv${low?.level} → Lv${(low?.level ?? 0) + 1}).`;
    }
    else if (/POKé FLUTE/.test(it.name)) {
      // only worth offering where something is asleep on the map (a Snorlax blocking the road)
      const sleeper = gs.sprites().some((sp) => !sp.hidden && SPRITES[sp.picture] === 'SNORLAX');
      desc = sleeper ? 'Plays a tune that wakes up sleeping Pokémon (like a Snorlax blocking a road).' : '';
    }
    else if (/BICYCLE/.test(it.name)) desc = surfing ? '' : 'Ride the bicycle (faster travel).';
    else if (/ESCAPE ROPE/.test(it.name)) desc = 'Escape from a cave/dungeon back to the last Pokémon Center.';
    if (!desc) continue;
    // opened before and closed without using it (nothing changed): say so, and stop offering after 3
    const unused = mem.itemUnused?.[it.name] ?? 0;
    if (unused >= 3) continue;
    add(`Use ${it.name} from the bag`, `${desc}${unused ? ` Opened ${unused} time(s) before and closed without using it.` : ''}`, { kind: 'item', name: it.name }, []);
  }
  // a full bag: items on the ground can't be picked up; any non-key item can be thrown away to free a slot
  if (gs.bag().length < 20 && mem.itemUnused?.['BAG (toss)']) delete mem.itemUnused['BAG (toss)'];
  if (gs.bag().length >= 20) {
    const tossable = gs.bag().filter((it) => !rom.isKeyItem(it.id)).map((it) => it.name);
    const bagUnused = mem.itemUnused?.['BAG (toss)'] ?? 0;
    if (tossable.length && bagUnused < 3) add('Open the bag to toss an item', `The bag is full (20 of 20 item slots), so items on the ground can't be picked up. In the bag, an item's menu offers TOSS (throws it away for good and frees a slot). Items that can be tossed: ${tossable.join(', ')}.${bagUnused ? ` Opened ${bagUnused} time(s) before and closed without tossing.` : ''}`, { kind: 'toss', name: '' }, []);
  }

  // Tall grass (wild encounters: train / catch)
  const gp = findPath(g, px, py, (x, y) => g.grass(x, y), { blocked, maxNodes: 8000 });
  if (gp) add('Walk in tall grass', 'Wander in tall grass to find wild Pokémon (gain experience / catch new team members).', { kind: 'grass' }, gp);
  // indoor maps with wild Pokémon (caves): encounters happen on any floor square, no tall grass needed
  else if (g.wild(px, py) || [...Object.values(DIRS)].some(([dx, dy]) => g.wild(px + dx, py + dy) && !blocked.has(`${px + dx},${py + dy}`))) add('Walk around here to meet wild Pokémon', 'In this place wild Pokémon can appear on any floor square (like tall grass outdoors): walking around finds them (gain experience / catch new team members).', { kind: 'grass' }, []);

  // Explore unseen squares
  const seenSq = mem.stepsInMap[gs.mapName] ?? new Set();
  const ep = findPath(g, px, py, (x, y) => !seenSq.has(`${x},${y}`) && Math.abs(x - px) + Math.abs(y - py) >= 6, { blocked, maxNodes: 8000 });
  if (ep) {
    // where the walk ends: same route facts as any other destination on this map
    const end = ep[ep.length - 1];
    const er = end ? rg.regionAt(gs.mapId, end.x, end.y) : null;
    // with a gate closed, layout distances say nothing about where exploring gets you: no claim either way
    const eFact = mem.gatedRoute ? '' : er && er !== hereRegion ? ` ${routeFacts(gs.mapId, [er])}` : isFinite(hereHops) && hereHops > 0 ? ' Stays in the current area (does not bring the objective closer).' : '';
    add('Explore this area', `Walk to a part of ${gs.mapName} not yet explored.${eFact}`, { kind: 'explore' }, ep);
  }

  // Distinct options must have distinct names (e.g. several ladders to the same floor lead to different areas)
  const counts = new Map<string, number>();
  for (const c of out) counts.set(c.key, (counts.get(c.key) ?? 0) + 1);
  for (const c of out) {
    if ((counts.get(c.key) ?? 0) < 2) continue;
    const t = c.target as { x?: number; y?: number };
    if (t.x !== undefined) c.key = c.key.replace(/^Enter /, `Take the exit at (${t.x},${t.y}) to `);
  }
  // this floor still has a switch / hole waiting for a boulder while the way is gated: leaving the floor can't get
  // past a gate this floor opens, so exits make no layout "toward" claim
  const liveBoulders = gs.sprites().filter((sp) => !sp.hidden && SPRITES[sp.picture] === 'BOULDER');
  if (mem.gatedRoute && openTargets(gs, liveBoulders).length) {
    for (const c of out) if (c.target.kind === 'warp' || c.target.kind === 'exit') c.desc = c.desc.replace(/ ?Leads toward the objective \(\d+ area\(s\) away from it\) \(by the map layout; a gate on the way is closed right now\)\./, '');
  }
  // gated, and nothing reachable leads toward the objective by the layout: then "away" (by layout) says nothing
  // useful either (the layout's way runs through a closed part), so drop those claims
  if (mem.gatedRoute && !out.some((c) => /Leads toward the objective/.test(c.desc))) {
    for (const c of out) c.desc = c.desc.replace(/ ?Leads away from the objective \(\d+ areas away\) \(by the map layout; a gate on the way is closed right now\)\./, '');
  }
  // mid-puzzle: while a push toward a switch is on offer, wandering off (explore / exits that lead away, which also
  // reset the boulders) isn't offered
  if (out.some((c) => c.target.kind === 'push' && /Leads toward the objective/.test(c.desc))) {
    for (const c of [...out]) {
      const away = (c.target.kind === 'warp' || c.target.kind === 'exit') && /Leads away from the objective/.test(c.desc);
      if (c.target.kind === 'explore' || away) out.splice(out.indexOf(c), 1);
    }
  }
  // the same team keeps losing at a place: while that holds (see the intent rule), its entrance isn't offered either
  const lostAt = lossBlockedPlace(ctx);
  if (lostAt && !(lostAt === 'the Elite Four' && E4_ROOMS.test(gs.mapName)) && gs.mapName !== lostAt) {
    for (const c of [...out]) {
      if (c.target.kind !== 'warp' && c.target.kind !== 'exit') continue;
      const destName = rom.maps.get(c.target.dest)?.name ?? '';
      if (lostAt === 'the Elite Four' ? E4_ROOMS.test(destName) : destName === lostAt) out.splice(out.indexOf(c), 1);
    }
    // moving on isn't offered while that holds, so exits carry no toward/away-from-the-objective claims either
    for (const c of out) c.desc = c.desc.replace(/ ?(Leads toward the objective|Leads away from the objective|Same distance from the objective|Does not lead toward the objective) \((?:[^()]|\([^()]*\))*\)( \(by the map layout[^)]*\))?\./g, '').trim();
  }
  // can a Pokémon Center be reached from here at all? (a heal focus with no way to one isn't offered)
  healReachable = { map: gs.mapId, ok: PC_MAPS.test(gs.mapName) || out.some((c) => /Pokémon Center/.test(c.desc) || c.key.includes('NURSE')),
    mart: MART_MAPS.test(gs.mapName) || /MART/.test(gs.mapName) || out.some((c) => /Poké Mart/.test(c.desc) || c.key.includes('CLERK')) };
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
    // generous: with many sprites on screen the game lags and one step can take well over 40 frames
    for (let f = 0; f < 90; f++) {
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
      const map0 = gs.mapId;
      // the last step onto the warp square can be dropped (a press that only turns the player): step onto it first
      for (let i = 0; i < 3 && gs.mapId === map0 && Math.abs(gs.x - t.x) + Math.abs(gs.y - t.y) === 1 && !gs.screen().hasTextBox; i++) {
        const d = t.x > gs.x ? 'RIGHT' : t.x < gs.x ? 'LEFT' : t.y > gs.y ? 'DOWN' : 'UP';
        emu.hold(d, 16);
        emu.wait(20);
      }
      if (gs.mapId !== map0) return;
      // carpet/edge warps need a push toward the edge
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
      // a talk with a shop clerk is the shopping trip: once it's over, the shop focus is done (bought or not),
      // also for clerks outside a Mart (Indigo Plateau lobby)
      if (t.sprite === 'CLERK' && ctx.mem.intent?.value === 'shop') ctx.mem.shopDone = true;
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
      if (/^Press the switch/.test(c.key)) { ctx.mem.switchPressedOn = gs.mapName; ctx.mem.switchFact = (c.desc.match(/(?:Pressing it|After pressing it)[^()]*(?:\([^)]*\))?[^.]*\.|Switches in this building[^.]*\./) ?? [''])[0]; }
      if (/^Use the PC/.test(c.key)) ctx.mem.pcSession = { steps: 0, sig: '' };
      ctx.mem.lastInteraction = `${gs.mapName}:hidden${t.x},${t.y}`;
      ctx.mem.currentTalk = [];
      face(ctx, t.x, t.y);
      tap(ctx, 'A', 20);
      return;
    }
    case 'toss': {
      tossItem(ctx, t.name);
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
      // never pace onto a warp (ladders/exits) or a hole
      const noStep = new Set([...(ctx.rom.maps.get(gs.mapId)?.warps ?? []).map((w) => `${w.x},${w.y}`), ...HOLES.filter((h) => h.from === gs.mapName).map((h) => `${h.x},${h.y}`)]);
      for (let i = 0; i < 80 && !gs.inBattle && !gs.screen().hasTextBox; i++) {
        const opts = (Object.keys(DIRS) as Dir[]).filter((d) => { const [dx, dy] = DIRS[d]; return g.wild(gs.x + dx, gs.y + dy) && !noStep.has(`${gs.x + dx},${gs.y + dy}`); });
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
// `event`: the game's flag for "a boulder is on it / went through it" (the game resets these when you leave the area)
const FLOOR_FEATURES: Record<string, { x: number; y: number; kind: 'switch' | 'hole'; event: string }[]> = {
  VICTORY_ROAD_1F: [{ x: 17, y: 13, kind: 'switch', event: 'EVENT_VICTORY_ROAD_1_BOULDER_ON_SWITCH' }],
  VICTORY_ROAD_2F: [{ x: 1, y: 16, kind: 'switch', event: 'EVENT_VICTORY_ROAD_2_BOULDER_ON_SWITCH1' }, { x: 9, y: 16, kind: 'switch', event: 'EVENT_VICTORY_ROAD_2_BOULDER_ON_SWITCH2' }],
  VICTORY_ROAD_3F: [{ x: 3, y: 5, kind: 'switch', event: 'EVENT_VICTORY_ROAD_3_BOULDER_ON_SWITCH1' }, { x: 23, y: 15, kind: 'hole', event: 'EVENT_VICTORY_ROAD_3_BOULDER_ON_SWITCH2' }],
};
/** Switches and holes on this floor still waiting for a boulder (the game's flag isn't set and none sits on it). */
function openTargets(gs: Ctx["gs"], boulders: { x: number; y: number }[]) {
  return (FLOOR_FEATURES[gs.mapName] ?? []).filter((f) => !gs.event(f.event) && !boulders.some((o) => o.x === f.x && o.y === f.y));
}

/** The place the same team keeps losing at (2+ whole-team losses, team unchanged since): 'progress' is blocked there. */
function lossBlockedPlace(ctx: Ctx): string | null {
  const party = ctx.gs.party();
  const lineup = (t: string) => t.split(', ').map((x) => x.replace(/ Lv\d+$/, '')).sort().join(',');
  const levels = (t: string) => t.split(', ').reduce((a, x) => a + +(x.match(/Lv(\d+)$/)?.[1] ?? 0), 0);
  const teamNow = party.map((p) => `${p.species} Lv${p.level}`).join(', ');
  const movesNow = party.flatMap((p) => p.moves.map((m) => m.name)).sort().join(',');
  const hit = Object.entries(ctx.mem.losses ?? {}).find(([, l]) => l.count >= 2 && lineup(l.team) === lineup(teamNow) && levels(teamNow) - levels(l.team) < 5 && (!l.moves || l.moves === movesNow));
  return hit ? hit[0] : null;
}
// places with a nurse / a shop clerk (the Indigo Plateau lobby has both without being named a Pokémon Center / Mart)
const PC_MAPS = /POKECENTER|^INDIGO_PLATEAU_LOBBY$/;
const MART_MAPS = /_MART$|^INDIGO_PLATEAU_LOBBY$/;
const E4_ROOMS = /^(LORELEIS|BRUNOS|AGATHAS|LANCES|CHAMPIONS)_ROOM$/;

const FOCUS_TTL = 30;
// 'explore' has no finish line of its own (unlike heal / shop / a catch): re-ask sooner
const EXPLORE_TTL = 10;
let lastMapWasMart = false;
const MAX_REPEATS_NO_PROGRESS = +(process.env.MAX_REPEATS_NO_PROGRESS ?? 5);

const INTENTS: Record<string, string> = {
  progress: 'Move toward the current objective now.',
  heal: 'Go heal the party at a Pokémon Center.',
  train: 'Train: fight wild Pokémon (in tall grass, or anywhere in caves) to gain levels before the objective.',
  catch: 'Catch new wild Pokémon to build a stronger, more varied team.',
  shop: 'Buy supplies (Poké Balls, Potions) at a Poké Mart.',
  explore: 'Talk to people / explore this area for items or information.',
  team: "Change the team at a Pokémon Center PC (BILL's PC): deposit team members and withdraw Pokémon from the box.",
};

/** What the team focus waits for: the set of Pokémon owned (team + box). Level-ups don't count, a new catch does. */
function teamSignature(ctx: Ctx) {
  return [...ctx.gs.party().map((p) => p.species), ...ctx.gs.box().map((m) => m.species)].sort().join(',');
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
  // a single faint (a weak member in a wild fight) doesn't re-ask; half the team down or low total HP does
  const faintBand = fainted >= Math.ceil(party.length / 2) ? 'many' : 'few';
  const key = `${hpFrac < 0.25 ? 'low' : 'ok'}|${faintBand}|${party.map((p) => p.species).join(',')}:${Math.floor(party.reduce((a, p) => a + p.level, 0) / 5)}|${gs.badges}|${currentMilestone(gs).index}|${gs.bag().map((i) => i.name).join(',')}|${ctx.mem.fieldMoveNeeded ?? ''}|${lossBlockedPlace(ctx) ?? ''}`; // money isn't part of it: trainer wins change it all the time (shop has its own money rule)
  // re-ask Jev every FOCUS_TTL overworld decisions even if nothing changed, so a focus can't trap it
  // a finished focus is re-asked (e.g. 'heal' once everyone is at full HP with no status problems)
  const healed = party.every((p) => p.hp === p.maxHp && p.status === 'OK');
  // 'shop' is done once we've left a Mart (bought or not), so it can't send us straight back in
  const leftMart = ctx.mem.intent?.value === 'shop' && !/MART/.test(gs.mapName) && lastMapWasMart;
  lastMapWasMart = false; // one-shot: only the first decision after leaving a Mart
  const noHealHere = healReachable?.map === gs.mapId && !healReachable.ok;
  const noMartHere = healReachable?.map === gs.mapId && !healReachable.mart;
  const done = (ctx.mem.intent?.value === 'progress' && !!ctx.mem.fieldMoveNeeded && !lastObjectiveReachable) || (ctx.mem.intent?.value === 'heal' && (healed || noHealHere)) || (ctx.mem.intent?.value === 'shop' && noMartHere) || (ctx.mem.intent?.value === 'team' && noHealHere) || leftMart || (ctx.mem.intent?.value === 'shop' && !!ctx.mem.shopDone) || (ctx.mem.intent?.value === 'team' && !!ctx.mem.pcDone);
  if (done && ctx.mem.intent?.value === 'team') { ctx.mem.teamSig = teamSignature(ctx); ctx.mem.teamAt = Date.now(); }
  if (done && ctx.mem.intent?.value === 'shop') { ctx.mem.shopMoney = gs.money; ctx.mem.shopAt = Date.now(); }
  if (done) { ctx.mem.shopDone = false; ctx.mem.pcDone = false; }
  if (!done && ctx.mem.intent?.key === key && (ctx.mem.intent.age = (ctx.mem.intent.age ?? 0) + 1) <= (ctx.mem.intent.value === 'explore' ? EXPLORE_TTL : FOCUS_TTL)) return ctx.mem.intent.value;
  const balls = gs.bag().filter((i) => /BALL$/.test(i.name)).reduce((a, i) => a + i.qty, 0);
  const criteria = { ...INTENTS };
  const weakNote = weakTeamNote(ctx);
  criteria.catch = `${INTENTS.catch} Team size ${party.length}/6. Poké Balls in bag: ${balls}.${balls === 0 ? ' Catching needs a Poké Ball: with none in the bag, wild Pokémon can only be fought, not caught.' : ''}${weakNote ? ` ${weakNote}` : ''}`;
  const healItems = gs.bag().filter((i) => /POTION|FRESH WATER|SODA POP|LEMONADE|FULL RESTORE|REVIVE/.test(i.name));
  const healNote = ` Healing items in the bag: ${healItems.length ? healItems.map((i) => `${i.name} x${i.qty}`).join(', ') : 'none'} (they heal on the spot, without walking to a Pokémon Center).`;
  criteria.shop = `${INTENTS.shop} Money: ¥${gs.money}. Prices: Poké Ball ¥200, Potion ¥300 (heals 20 HP), Super Potion ¥700 (heals 50 HP), Antidote ¥100.${healNote}`;
  // impossible focuses aren't offered (same rule as unusable items)
  // shop is offered when there's money to spend: ¥100+, and ¥200+ more than when the last shop visit ended
  // after a Mart visit, shopping is offered again once ¥200 more was earned, or 15 minutes later (can't loop fast either way)
  const shopCooldown = ctx.mem.shopMoney !== undefined && gs.money < ctx.mem.shopMoney + 200 && Date.now() - (ctx.mem.shopAt ?? 0) < 15 * 60_000;
  if (gs.money < 100 || shopCooldown) delete (criteria as Record<string, string>).shop;
  // no ball and no way to get one (no money, or a full bag that can't take a new kind of item): catching is impossible
  if (balls === 0 && (gs.money < 200 || gs.bag().length >= 20)) delete (criteria as Record<string, string>).catch;
  criteria.heal = `${INTENTS.heal} Healing at a Pokémon Center is free.${healNote}`;
  // no way to a Pokémon Center from here (e.g. a floor cut off until a puzzle is solved): not offered, like other impossible focuses
  if (noHealHere) delete (criteria as Record<string, string>).heal;
  // nothing to heal (full HP, no status, full PP): a Pokémon Center visit changes nothing, so it isn't offered
  if (healed && party.every((p) => p.moves.every((m) => m.pp >= m.maxPp))) delete (criteria as Record<string, string>).heal;
  if (noMartHere) delete (criteria as Record<string, string>).shop;
  // loop rule: the same team lost everything at the same place 2+ times -> 'progress' comes back once the team changes
  // "changed" = a different lineup, or 5+ levels gained in total since that last loss
  const lineup = (t: string) => t.split(', ').map((x) => x.replace(/ Lv\d+$/, '')).sort().join(',');
  const levels = (t: string) => t.split(', ').reduce((a, x) => a + +(x.match(/Lv(\d+)$/)?.[1] ?? 0), 0);
  const teamNow = party.map((p) => `${p.species} Lv${p.level}`).join(', ');
  const movesNow = party.flatMap((p) => p.moves.map((m) => m.name)).sort().join(',');
  // (not while already inside the Elite Four: there the only way is forward)
  const stuckAt = E4_ROOMS.test(gs.mapName) ? undefined : Object.entries(ctx.mem.losses ?? {}).find(([, l]) => l.count >= 2 && lineup(l.team) === lineup(teamNow) && levels(teamNow) - levels(l.team) < 5 && (!l.moves || l.moves === movesNow));
  if (stuckAt) {
    delete (criteria as Record<string, string>).progress;
    const note = ` (Moving on toward the objective isn't offered right now: all your Pokémon fainted at ${stuckAt[0]} ${stuckAt[1].count} times with exactly this team and these levels. It is offered again once the team changes: a different lineup, a newly learned move, or 5+ levels gained in total since then.)`;
    for (const k of Object.keys(criteria)) (criteria as Record<string, string>)[k] += note;
  }
  // nothing to walk toward: the objective needs a field move no team member knows, and there's no place to go for it
  else if (ctx.mem.fieldMoveNeeded && !lastObjectiveReachable) {
    delete (criteria as Record<string, string>).progress;
    const note = ` (Moving on toward the objective isn't offered right now: it can't be reached without ${ctx.mem.fieldMoveNeeded}, which no team member knows yet.)`;
    for (const k of Object.keys(criteria)) (criteria as Record<string, string>)[k] += note;
  }
  // swapping is only possible with Pokémon in the box
  const box = gs.box();
  // offered only when there's something in the box, and the team/box changed since the PC was last used
  // (re-offered for that reason at most every 15 minutes, like the shop)
  const boxLearner = !!ctx.mem.fieldMoveNeeded && Date.now() - (ctx.mem.teamAt ?? 0) > 15 * 60_000 && (() => { const l = fieldMoveLearners(ctx, ctx.mem.fieldMoveNeeded!); return l.box.length > 0 || l.afterEvolving.some((t) => t.startsWith('in the PC box')); })();
  if (box.length && (ctx.mem.teamSig !== teamSignature(ctx) || boxLearner)) {
    const lvls = party.map((p) => p.level);
    criteria.team = `${INTENTS.team}${weakNote ? ` ${weakNote}` : ''} In the box: ${box.map((m) => `${m.nickname} (${m.species} Lv${m.level}, ${m.types.join('/')})`).join(', ')}. Team: ${party.map((p) => `${p.nickname} (${p.species} Lv${p.level}, ${p.types.join('/')})`).join(', ')}. Team levels range ${Math.min(...lvls)}-${Math.max(...lvls)}.`;
  } else delete (criteria as Record<string, string>).team;
  if (noHealHere) delete (criteria as Record<string, string>).team; // the PC is in a Pokémon Center
  if (criteria.train) criteria.train = criteria.train.replace(INTENTS.train, `${INTENTS.train} Beating trainers also earns money.`);
  if (criteria.progress && isFinite(lastHereHops)) criteria.progress = `${criteria.progress} From here the objective is ${lastHereHops} area(s) away.`;
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
let lastObjectiveDist: { dist: Map<string, number>; rg: ReturnType<typeof regionGraph>; objMaps: number[]; atRegion: string | null } | null = null;
/** Areas from a map to the current objective (from the latest overworld decision), for menus like elevator floors. */
export function hopsFromMap(mapId: number, via?: number): number | undefined {
  const o = lastObjectiveDist;
  if (!o) return undefined;
  const regions = arrivalRegions(mapId, via);
  if (regions) {
    if (o.atRegion ? regions.includes(o.atRegion) : o.objMaps.includes(mapId)) return 0;
    return hopsIn(o.dist, regions);
  }
  if (o.objMaps.includes(mapId)) return 0;
  return hopsIn(o.dist, o.rg.regionsOf(mapId));
}
// arriving from `via` (e.g. an elevator): only the areas its doors actually lead into count
function arrivalRegions(mapId: number, via?: number): string[] | undefined {
  const o = lastObjectiveDist;
  const md = via !== undefined && o ? o.rg.mapData(mapId) : undefined;
  const regions = md ? md.warps.filter((w) => w.destMap === via).map((w) => o!.rg.regionAt(mapId, w.x, w.y)).filter((r): r is string => !!r) : [];
  return regions.length ? regions : undefined;
}
function hopsIn(dist: Map<string, number>, regions: string[]) {
  const h = Math.min(Infinity, ...regions.map((r) => dist.get(r) ?? Infinity));
  return isFinite(h) ? h : undefined;
}
let lastObjectiveReachable = true; // updated by every candidate build
let lastHereHops = Infinity;
/** after pressing a switch here: the flipped graph and its distances (switch-gated buildings only) */
let switchAfter: { alt: RegionGraph; db: Map<string, number> } | null = null;
/** service (Pokémon Center / Mart) distances across switch positions, by service regex source */
const switchSvc: Record<string, { da: Map<string, number>; db: Map<string, number> }> = {};
let lastServiceDist: { pc: Map<string, number>; mart: Map<string, number> } | null = null;
let healReachable: { map: number; ok: boolean; mart: boolean } | null = null;
/** " Toward the nearest Pokémon Center (N areas)." etc. for a map entered from `via`, when closer than `from` */
export function serviceFactsFromMap(mapId: number, via: number): string {
  const o = lastObjectiveDist, sv = lastServiceDist;
  if (!o || !sv) return '';
  const regions = arrivalRegions(mapId, via) ?? o.rg.regionsOf(mapId);
  const f = (d: Map<string, number>, label: string) => {
    const here = hopsIn(d, o.rg.regionsOf(via)), there = hopsIn(d, regions);
    return there !== undefined && (here === undefined || there < here) ? ` Toward the nearest ${label} (${there} areas).` : '';
  };
  return f(sv.pc, 'Pokémon Center') + f(sv.mart, 'Poké Mart');
}
let pendingItem: { name: string; sig: string } | null = null;
const itemSig = (ctx: Ctx) => `${ctx.gs.bag().map((i) => i.name + i.qty).join(',')}|${ctx.gs.party().map((p) => p.level + p.moves.map((m) => m.name).join('+') + p.hp + p.status).join(',')}`;

export async function overworldStep(ctx: Ctx, agent: Agent) {
  // a script is still running without a text box: wait for it (capped, so this can never hang)
  if (busyWaited < 1800 && !overworldReady(ctx)) { ctx.emu.wait(20); busyWaited += 24; return; }
  busyWaited = 0;
  ctx.mem.pcSession = undefined; // back in the overworld: any PC session is over
  // a bag item opened last time: did anything change (used) or not (closed without using it)?
  if (pendingItem) {
    const u = (ctx.mem.itemUnused ??= {});
    if (itemSig(ctx) === pendingItem.sig) u[pendingItem.name] = (u[pendingItem.name] ?? 0) + 1; else delete u[pendingItem.name];
    pendingItem = null;
  }
  resetMenuRepeats();
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
      await runChosen(ctx, again, agent, () => {});
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
  // pushes are counted per visit (boulders reset when you leave, so a new visit starts fresh)
  const tk = (c: Candidate) => c.target.kind === 'push' ? `${ctx.gs.mapName}#${ctx.mem.visitedMaps[ctx.gs.mapName] ?? 0}:${c.key}` : `${ctx.gs.mapName}:${c.key}`;
  const towardObjective = (c: Candidate) => /Leads toward the objective|objective is in this place/.test(c.desc);
  // boulder puzzles reset when you leave: activating STRENGTH is needed again each visit, so the repeat rule skips it
  const exempt = (c: Candidate) => c.target.kind === 'strength';
  let pool = cands.filter((c) => towardObjective(c) || exempt(c) || (tried[tk(c)] ?? 0) < MAX_REPEATS_NO_PROGRESS);
  if (!pool.length) { ctx.mem.triedNoProgress = {}; pool = cands; }
  const criteria: Record<string, string> = {};
  const FOCUS: Record<string, RegExp> = {
    heal: /Pokémon Center|heals the whole party|NURSE/,
    shop: /Poké Mart|Shop clerk|CLERK/,
    team: /Use the PC|Pokémon Center/,
    train: /tall grass|meet wild Pokémon|Wild Pokémon appear there/,
    catch: /tall grass|meet wild Pokémon|Wild Pokémon appear there/,
    progress: /Leads toward the objective|objective is in this place|objective takes place|Mentioned in the current objective|changes which gates are closed|opens it\./,
  };
  // wild Pokémon right here: exits to other wild places aren't the focus match (walking between them meets fewer)
  if ((intent === 'train' || intent === 'catch') && pool.some((c) => c.target.kind === 'grass')) FOCUS[intent] = /tall grass|meet wild Pokémon/;
  for (const c of pool) {
    const n = exempt(c) ? 0 : tried[tk(c)] ?? 0;
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
  const triedN = (k: string) => { const cc = pool.find((x) => x.key === k); return cc ? tried[tk(cc)] ?? 0 : 0; };
  if (triedN(key) >= 3 && ans.probabilities) {
    const alts = Object.entries(ans.probabilities).filter(([k]) => k !== key);
    const total = alts.reduce((a, [, p]) => a + p + 0.05, 0);
    let r = Math.random() * total;
    for (const [k, p] of alts) { r -= p + 0.05; if (r <= 0) { key = k; break; } }
    ctx.log('info', `"${ans.choice}" already tried ${triedN(ans.choice)}x with no change → trying "${key}" instead`);
  }
  const c = pool.find((k) => k.key === key)!;
  if (!exempt(c)) tried[tk(c)] = (tried[tk(c)] ?? 0) + 1;
  // remember pushes that strand the boulder, across visits (boulders reset when you leave, the memory doesn't)
  if (c.target.kind === 'push' && /cannot be pushed from any side|no sequence of pushes/.test(c.desc)) {
    const sk = `${ctx.gs.mapName}:${c.key}`;
    (ctx.mem.stuckPushes ??= {})[sk] = (ctx.mem.stuckPushes[sk] ?? 0) + 1;
  }
  const uk = `${ctx.gs.mapName}:${c.key}`;
  ctx.mem.usedTargets[uk] = (ctx.mem.usedTargets[uk] ?? 0) + 1;
  agent.noteDecision(`${ctx.gs.mapName}: ${c.key}`);
  ctx.log('decision', `${ctx.gs.mapName}: ${c.key}`, { options: cands.length });
  ctx.mem.lastInteraction = null;
  await runChosen(ctx, c, agent, () => { tried[tk(c)] = Math.max(0, (tried[tk(c)] ?? 1) - 1); });
}

/** Execute a chosen (or resumed) target and record whether an exit attempt got through (and what stopped it). */
async function runChosen(ctx: Ctx, c: Candidate, agent: Agent, battleInterrupt: () => void) {
  const mapBefore = ctx.gs.mapId, mapNameBefore = ctx.gs.mapName;
  const fromRegion = regionGraph(ctx).regionAt(mapBefore, ctx.gs.x, ctx.gs.y);
  const goal = c.path[c.path.length - 1];
  const distTo = () => (goal ? Math.abs(ctx.gs.x - goal.x) + Math.abs(ctx.gs.y - goal.y) : 0);
  const distStart = distTo();
  const tg = c.target as { kind: string; x?: number; y?: number; dir?: string };
  const edges = (destRegionsByKey.get(tg.kind === 'warp' ? `w:${tg.x},${tg.y}` : `e:${tg.dir}`) ?? []).map((r) => `${fromRegion}>${r}`);
  if (c.target.kind === 'item') pendingItem = { name: (c.target as { name: string }).name, sig: itemSig(ctx) };
  if (c.target.kind === 'toss') pendingItem = { name: 'BAG (toss)', sig: itemSig(ctx) };
  const res = await execute(ctx, c, agent);
  const bE = (ctx.mem.blockedEdges ??= {});
  // a warp to the same map (teleport pads) doesn't change the map: it worked if we're now off in another area
  const sameMapWarp = tg.kind === 'warp' && (c.target as { dest: number }).dest === mapBefore;
  const arrived = () => ctx.gs.mapId !== mapBefore || (sameMapWarp && regionGraph(ctx).regionAt(mapBefore, ctx.gs.x, ctx.gs.y) !== fromRegion && Math.abs(ctx.gs.x - tg.x!) + Math.abs(ctx.gs.y - tg.y!) > 1);
  if (arrived()) { for (const e of edges) delete bE[e]; delete ctx.mem.blockedExits[`${mapNameBefore}:${c.key}`]; } // it worked this time
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
    for (let i = 0; i < 300 && !arrived() && !battleComing(); i++) settleTap();
    for (let i = 0; i < 400 && !battleComing() && (ctx.gs.screen().hasTextBox || (ctx.gs.joyIgnore & 0xf0) || (ctx.gs.u8('wStatusFlags5') & 0x80)); i++) settleTap();
    if (battleComing()) { battleInterrupt(); return; }
    // stopped = a speech sent us back, or the walk finished and we're still here; a silent interruption
    // (ledge hop, cutscene) is not a failure: the walk gets resumed
    // a speech only means "stopped" if we didn't get any closer (a guard sends you back; a healing zone doesn't)
    const advanced = distTo() <= distStart - 2;
    if (!arrived() && ((said.length && !advanced) || (isExit && res !== 'interrupted' && !said.length))) {
      const k = `${mapNameBefore}:${c.key}`;
      ctx.mem.blockedExits[k] = (ctx.mem.blockedExits[k] ?? 0) + 1;
      if (said.length) ctx.mem.npcText[`${k}:blocked`] = said.join(' ').slice(-1500);
      // sent back by a speech: the square we were about to step onto triggered it; walk around it from now on
      if (said.length && !advanced && c.path.length) {
        const i = c.path.findIndex((st) => st.x === ctx.gs.x && st.y === ctx.gs.y);
        const next = i >= 0 ? c.path[i + 1] : c.path.reduce((a, st) => Math.abs(st.x - ctx.gs.x) + Math.abs(st.y - ctx.gs.y) === 1 && (!a || c.path.indexOf(st) > c.path.indexOf(a)) ? st : a, undefined as Step | undefined);
        if (next && !(next.x === tg.x && next.y === tg.y)) {
          const t = ((ctx.mem.trapSquares ??= {})[mapNameBefore] ??= []);
          if (!t.includes(`${next.x},${next.y}`)) { t.push(`${next.x},${next.y}`); ctx.log('info', `(${next.x},${next.y}) on ${mapNameBefore} sent us back: walking around it from now on`); }
        }
      }
      if (isExit && fromRegion) for (const e of edges) bE[e] = (bE[e] ?? 0) + 1;
      pendingTarget = null; // stopped, not merely interrupted: let Jev decide again
      ctx.log('info', `${c.key}: did not get through (${ctx.mem.blockedExits[k]}x, walk ${res}, at ${ctx.gs.x},${ctx.gs.y})${said.length ? ` — "${said.join(' ').slice(0, 80)}"` : ''}`);
    }
  }
}
