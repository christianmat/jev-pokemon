import type { Ctx } from './context.js';
import { tap, situation, remember, rememberDialog } from './context.js';
import { findLabel, select, cursorTo, cursorToIndex, decideMenu, confirmA } from './menus.js';
import { advanceText, isNamingScreen, dialogStep } from './dialog.js';
import { sym } from '../game/symbols.js';

const PHYSICAL = new Set(['NORMAL', 'FIGHTING', 'FLYING', 'POISON', 'GROUND', 'ROCK', 'BUG', 'GHOST']);
const HEAL: Record<string, number> = { POTION: 20, 'SUPER POTION': 50, 'HYPER POTION': 200, 'MAX POTION': 999, 'FULL RESTORE': 999, 'FRESH WATER': 50, 'SODA POP': 60, LEMONADE: 80 };
const BALLS = ['POKé BALL', 'GREAT BALL', 'ULTRA BALL', 'MASTER BALL', 'SAFARI BALL'];

function gs_isSafari(ctx: Ctx) {
  return ctx.gs.u8('wBattleType') === 2 && !!findLabel(ctx, 'BAIT') && !!findLabel(ctx, 'RUN');
}

function isMainMenu(ctx: Ctx) {
  const s = ctx.gs.screen();
  return !!s.cursor && !!findLabel(ctx, 'FIGHT') && !!findLabel(ctx, 'RUN');
}

/** Stats of a battle_struct at `a` (big-endian). */
function stats(ctx: Ctx, a: number) {
  const m = ctx.emu.mem, be = (o: number) => (m[a + o] << 8) | m[a + o + 1];
  return { level: m[a + 14], atk: be(17), def: be(19), spd: be(21), spc: be(23) };
}

/** Expected damage range (Gen 1 formula; information only). */
function estimate(level: number, power: number, a: number, d: number, stab: boolean, eff: number) {
  if (!power || !eff) return [0, 0];
  const base = Math.floor(Math.floor(Math.floor((2 * level) / 5 + 2) * power * a / Math.max(1, d)) / 50) + 2;
  const hi = Math.floor(base * (stab ? 1.5 : 1) * eff);
  return [Math.floor((hi * 217) / 255), hi];
}

/** Rough Gen 1 capture chance for one ball (information only). */
function catchChance(ball: string, catchRate: number, hp: number, maxHp: number, status: string) {
  if (/MASTER/.test(ball)) return 1;
  const rmax = /GREAT/.test(ball) ? 201 : /ULTRA|SAFARI/.test(ball) ? 151 : 256;
  const sb = status === 'SLEEP' || status === 'FREEZE' ? 25 : status === 'OK' ? 0 : 12;
  const ballF = /GREAT/.test(ball) ? 8 : 12;
  const f = Math.min(255, Math.floor(Math.floor((maxHp * 255) / ballF) / Math.max(1, Math.floor(hp / 4))));
  const pStatus = sb / rmax;
  const pRate = Math.max(0, Math.min(1, (Math.min(catchRate, rmax - 1 - sb) + 1) / rmax));
  return Math.min(1, pStatus + (1 - pStatus) * pRate * ((f + 1) / 256));
}

function effWord(e: number) {
  return e === 0 ? 'NO effect (immune)' : e >= 4 ? 'super effective x4' : e >= 2 ? 'super effective x2' : e <= 0.25 ? 'not very effective x0.25' : e < 1 ? 'not very effective x0.5' : 'normal effectiveness';
}

async function decideBattle(ctx: Ctx) {
  const { gs, rom } = ctx;
  const b = gs.battle();
  const me = stats(ctx, sym('wBattleMon')), foe = stats(ctx, sym('wEnemyMon'));
  const party = gs.party();
  const opts: Record<string, string> = {};
  const actions: Record<string, () => void> = {};
  const focus = ctx.mem.intent?.value;
  const catching = focus === 'catch';

  for (const mv of b.player.moves) {
    const eff = rom.effectiveness(mv.type, b.enemy.types);
    const phys = PHYSICAL.has(mv.type);
    const stab = b.player.types.includes(mv.type);
    const [lo, hi] = estimate(me.level, mv.power, phys ? me.atk : me.spc, phys ? foe.def : foe.spc, stab, eff);
    const pct = b.enemy.maxHp ? Math.round((hi / b.enemy.hp) * 100) : 0;
    const koNote = b.kind === 'wild' && catching ? ' — knocks it out, so it can no longer be caught' : '';
    const dmg = mv.power ? `Estimated damage ${lo}-${hi} HP vs enemy's ${b.enemy.hp} HP left${lo >= b.enemy.hp ? ` (likely KO${koNote})` : pct > 50 ? ' (high damage)' : ''}.` : `Status move (no direct damage).${(mv.name === 'REFLECT' && (gs.u8('wPlayerBattleStatus3') & 4)) || (mv.name === 'LIGHT SCREEN' && (gs.u8('wPlayerBattleStatus3') & 2)) ? ' Already in effect: using it again does nothing.' : ''}`;
    const key = `Use ${mv.name}`;
    const effNote = mv.power ? `${effWord(eff)} against ${b.enemy.types.join('/')}. ${stab ? 'Same-type bonus. ' : ''}` : ''; // type matchups only matter for damaging moves
    opts[key] = mv.pp === 0 ? `${mv.name}: 0 PP left, unusable.` : `${mv.name}: ${mv.type} move, power ${mv.power}, accuracy ${mv.accuracy}%, ${mv.pp} PP left. ${effNote}${dmg}`;
    actions[key] = () => { if (!select(ctx, 'FIGHT')) return; if (cursorTo(ctx, mv.name)) confirmA(ctx); else tap(ctx, 'B', 20); };
  }

  for (const p of party) {
    if (p.slot === b.player.slot || p.hp === 0) continue;
    const attacks = p.moves.filter((m) => m.power > 0);
    const bestEff = attacks.length ? Math.max(...attacks.map((m) => rom.effectiveness(m.type, b.enemy.types))) : -1;
    const threat = Math.max(...b.enemy.types.map((t) => rom.effectiveness(t, p.types)));
    const key = `Switch to ${p.nickname}`;
    opts[key] = `Switch to ${p.nickname} (${p.species} Lv${p.level}, ${p.types.join('/')}, HP ${p.hp}/${p.maxHp}). ${bestEff < 0 ? 'It has no damaging moves;' : `Its best damaging move is ${effWord(bestEff)} vs the enemy;`} enemy's type is ${effWord(threat)} against it. Switching uses the turn.`;
    actions[key] = () => { if (!select(ctx, 'PKMN')) return; ctx.emu.wait(20); cursorToIndex(ctx, p.slot); confirmA(ctx); if (!select(ctx, 'SWITCH')) tap(ctx, 'B', 20); ctx.emu.wait(20); };
  }

  for (const it of gs.bag()) {
    if (HEAL[it.name] && b.player.hp < b.player.maxHp) {
      const key = `Use ${it.name}`;
      opts[key] = `Heal the active Pokémon by up to ${HEAL[it.name]} HP (currently ${b.player.hp}/${b.player.maxHp}). ${it.qty} left. Uses the turn.`;
      actions[key] = () => {
        if (!select(ctx, 'ITEM')) return; if (!cursorTo(ctx, it.name)) { tap(ctx, 'B', 20); return; } confirmA(ctx);
        ctx.emu.wait(20); cursorToIndex(ctx, b.player.slot); confirmA(ctx);
      };
    }
    // Revive a fainted teammate (they come back but stay benched until switched in)
    if (/^(REVIVE|MAX REVIVE)$/.test(it.name)) {
      for (const p of party.filter((pp) => pp.hp === 0)) {
        const key = `Use ${it.name} on ${p.nickname}`;
        opts[key] = `Revive fainted ${p.nickname} (${p.species} Lv${p.level}) to ${it.name === 'MAX REVIVE' ? 'full' : 'half'} HP. It stays out of battle until switched in. ${it.qty} left. Uses the turn.`;
        actions[key] = () => {
          if (!select(ctx, 'ITEM')) return; if (!cursorTo(ctx, it.name)) { tap(ctx, 'B', 20); return; } confirmA(ctx);
          ctx.emu.wait(20); cursorToIndex(ctx, p.slot); confirmA(ctx);
        };
      }
    }
    // Cure the active Pokémon's status
    const CURES: Record<string, string[]> = { ANTIDOTE: ['POISON'], 'BURN HEAL': ['BURN'], 'ICE HEAL': ['FREEZE'], AWAKENING: ['SLEEP'], 'PARLYZ HEAL': ['PARALYZED'], 'FULL HEAL': ['POISON', 'BURN', 'FREEZE', 'SLEEP', 'PARALYZED'] };
    if (CURES[it.name]?.includes(b.player.status)) {
      const key = `Use ${it.name}`;
      opts[key] = `Cures ${party[b.player.slot]?.nickname ?? 'the active Pokémon'}'s ${b.player.status.toLowerCase()} status. ${it.qty} left. Uses the turn.`;
      actions[key] = () => {
        if (!select(ctx, 'ITEM')) return; if (!cursorTo(ctx, it.name)) { tap(ctx, 'B', 20); return; } confirmA(ctx);
        ctx.emu.wait(20); cursorToIndex(ctx, b.player.slot); confirmA(ctx);
      };
    }
    if (/BALL$/.test(it.name) && b.kind === 'wild') {
      const key = `Throw ${it.name}`;
      const dex = [...rom.species.values()].find((sp) => sp.name === b.enemy.species)?.dex ?? 0;
      const isNew = dex && !gs.owned(dex) ? `NEW species you don't own yet. ` : 'You already own this species. ';
      const small = `Team size ${party.length}/6. `;
      // how it would fit the team (facts only)
      const teamTypes = new Set(party.flatMap((p) => p.types));
      const newTypes = b.enemy.types.filter((t) => !teamTypes.has(t));
      const lowerThan = party.filter((p) => p.level < b.enemy.level).length;
      const fit = `${newTypes.length ? `Its type(s) ${newTypes.join('/')} are not on your team yet. ` : 'Your team already has its type(s). '}Its level ${b.enemy.level} is higher than ${lowerThan} of your ${party.length} team members. ${party.length >= 6 ? 'Your team is full: a caught Pokémon goes to the PC box (it can be swapped in at a Pokémon Center PC). ' : ''}`;
      const pc = Math.round(100 * catchChance(it.name, b.enemy.catchRate, b.enemy.hp, b.enemy.maxHp, b.enemy.status));
      opts[key] = `Estimated catch chance ~${pc}% per ${it.name} right now. ${isNew}${fit}${small}Try to catch the wild ${b.enemy.species} (Lv${b.enemy.level}, ${b.enemy.types.join('/')}, catch rate ${b.enemy.catchRate}/255, HP ${b.enemy.hp}/${b.enemy.maxHp}, status ${b.enemy.status}). Lower HP and sleep/paralysis make catching easier. Party size ${party.length}/6. ${it.qty} left.`;
      actions[key] = () => { if (!select(ctx, 'ITEM')) return; if (cursorTo(ctx, it.name)) confirmA(ctx); else tap(ctx, 'B', 20); };
    }
  }

  if (b.kind === 'wild') {
    opts['Run away'] = `Flee from the wild ${b.enemy.species}. Speed ${me.spd} vs enemy ${foe.spd}${me.spd >= foe.spd ? ' (escape guaranteed)' : ' (may fail)'}. No experience gained.`;
    actions['Run away'] = () => select(ctx, 'RUN');
  }

  // Pokémon Tower without the SILPH SCOPE: the wild enemy shows only as "GHOST" and the player's Pokémon are too
  // scared to move (the game's IsGhostBattle rule). Report what the player sees, not the hidden species.
  const ghost = gs.inBattle === 1 && /^POKEMON_TOWER_[1-7]F$/.test(gs.mapName) && !gs.bag().some((i) => i.name === 'SILPH SCOPE');
  if (ghost) {
    for (const k of Object.keys(opts)) {
      if (k.startsWith('Use ') && !/: 0 PP left/.test(opts[k])) opts[k] = `${k.slice(4)}: the enemy is an unidentified GHOST and your Pokémon is too scared to move, so this does nothing.`;
      if (k.startsWith('Switch to ')) opts[k] = `${k}: any Pokémon is too scared to move against an unidentified GHOST. Switching uses the turn.`;
      if (k.startsWith('Throw ')) opts[k] = 'The unidentified GHOST dodges thrown balls: it cannot be caught.';
    }
    if (opts['Run away']) opts['Run away'] = `Flee from the unidentified GHOST. Speed ${me.spd}.`;
  }
  const enemyShown = ghost ? { species: 'GHOST (unidentified)', level: b.enemy.level } : { ...b.enemy, speed: foe.spd, attack: foe.atk, defense: foe.def, special: foe.spc };
  const state = {
    ...situation(ctx),
    battle: {
      kind: b.kind,
      enemy: enemyShown,
      enemyTrainerPokemonCount: b.kind === 'trainer' ? b.enemyPartyCount : undefined,
      active: { name: party[b.player.slot]?.nickname, species: b.player.species, level: b.player.level, hp: `${b.player.hp}/${b.player.maxHp}`, status: b.player.status, types: b.player.types, speed: me.spd },
    },
  };
  const goal = b.kind === 'wild' && catching
    ? "The player's current focus is catching new Pokémon."
    : 'Choose the best action for this battle.';
  const key = await ctx.jev.choose('battle', { ...state, currentFocus: focus }, `You are in a Pokémon battle. ${goal}`, opts);
  const shownName = ghost ? 'GHOST' : b.enemy.species;
  remember(ctx.mem.actions, `battle vs ${shownName}: ${key}`, 12);
  ctx.log('decision', `battle vs ${shownName} Lv${b.enemy.level}: ${key}`);
  actions[key]();
}

/** Facts for any in-battle generic menu (switch prompts, move-learning, faint replacement). */
function menuFacts(ctx: Ctx) {
  const party = ctx.gs.party();
  const moves = new Map([...ctx.rom.moves.values()].map((m) => [m.name, m]));
  return (label: string) => {
    const p = party.find((pp) => label.startsWith(pp.nickname));
    if (p) return `${p.nickname}: ${p.species} Lv${p.level}, ${p.types.join('/')}, HP ${p.hp}/${p.maxHp}${p.hp === 0 ? ' (fainted, unusable)' : ''}.`;
    const mv = moves.get(label.trim());
    if (mv) return `Move ${mv.name}: ${mv.type}, power ${mv.power}, accuracy ${mv.accuracy}%, ${mv.pp} PP.`;
    return '';
  };
}

/** Safari Zone battle menu: BALL / BAIT / THROW ROCK / RUN. Facts come from the game's Safari mechanics. */
async function decideSafari(ctx: Ctx) {
  const { gs } = ctx;
  const b = gs.battle();
  const balls = gs.u8('wNumSafariBalls');
  const rate = gs.u8('wEnemyMonActualCatchRate');
  const dex = [...ctx.rom.species.values()].find((sp) => sp.name === b.enemy.species)?.dex ?? 0;
  const owned = dex && gs.owned(dex) ? 'You already own this species.' : "NEW species you don't own yet.";
  const pc = Math.round(100 * catchChance('SAFARI BALL', rate, b.enemy.hp, b.enemy.maxHp, b.enemy.status));
  const opts: Record<string, string> = {
    'Throw SAFARI BALL': `Estimated catch chance ~${pc}% with the current catch rate (${rate}/255). ${balls} Safari Balls left. ${owned}`,
    'Throw BAIT': 'Halves the catch rate, and makes the Pokémon less likely to run away for 1-5 turns.',
    'Throw ROCK': 'Doubles the catch rate, and makes the Pokémon more likely to run away for 1-5 turns.',
    'Run away': 'Leave this encounter.',
  };
  const labels: Record<string, string> = { 'Throw SAFARI BALL': 'BALL', 'Throw BAIT': 'BAIT', 'Throw ROCK': 'ROCK', 'Run away': 'RUN' };
  const state = { ...situation(ctx), safari: { wild: `${b.enemy.species} Lv${b.enemy.level} (${b.enemy.types.join('/')})`, safariBalls: balls, catchRate: rate, stepsLeft: (gs.u8('wSafariSteps') << 8) | gs.u8('wSafariSteps', 1) } };
  const key = await ctx.jev.choose('battle', state, 'You are in a Safari Zone encounter: you cannot fight, only throw Safari Balls, bait or rocks, or run.', opts);
  remember(ctx.mem.actions, `safari vs ${b.enemy.species}: ${key}`, 12);
  ctx.log('decision', `safari vs ${b.enemy.species}: ${key}`);
  select(ctx, labels[key]);
}

export async function battleStep(ctx: Ctx) {
  const s = ctx.gs.screen();
  if (s.cursor && gs_isSafari(ctx)) return decideSafari(ctx);
  // nickname keyboard after a catch (game still flags "in battle")
  if (isNamingScreen(ctx)) return dialogStep(ctx);
  if (isMainMenu(ctx)) return decideBattle(ctx);
  // Move list re-opened (e.g. "No PP left!") → back out to the main battle menu and decide again
  if (s.cursor && s.rows.some((r) => r.includes('TYPE/'))) { tap(ctx, 'B', 12); return; }
  if (s.cursor && !s.waitingForA) {
    if (s.dialog) rememberDialog(ctx.mem, s.dialog);
    const picked = await decideMenu(ctx, 'battle-menu', menuFacts(ctx));
    if (picked) return;
  }
  if (s.dialog) rememberDialog(ctx.mem, s.dialog);
  advanceText(ctx, 90);
}
