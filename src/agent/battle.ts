import type { Ctx } from './context.js';
import { tap, situation, remember, rememberDialog } from './context.js';
import { findLabel, select, cursorTo, cursorToIndex, decideMenu, confirmA } from './menus.js';
import { advanceText, isNamingScreen, dialogStep } from './dialog.js';
import { sym } from '../game/symbols.js';

const PHYSICAL = new Set(['NORMAL', 'FIGHTING', 'FLYING', 'POISON', 'GROUND', 'ROCK', 'BUG', 'GHOST']);
const HEAL: Record<string, number> = { POTION: 20, 'SUPER POTION': 50, 'HYPER POTION': 200, 'MAX POTION': 999, 'FULL RESTORE': 999, 'FRESH WATER': 50, 'SODA POP': 60, LEMONADE: 80 };
const BALLS = ['POKé BALL', 'GREAT BALL', 'ULTRA BALL', 'MASTER BALL', 'SAFARI BALL'];

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
    const dmg = mv.power ? `Estimated damage ${lo}-${hi} HP vs enemy's ${b.enemy.hp} HP left${lo >= b.enemy.hp ? ` (likely KO${koNote})` : pct > 50 ? ' (high damage)' : ''}.` : 'Status move (no direct damage).';
    const key = `Use ${mv.name}`;
    opts[key] = mv.pp === 0 ? `${mv.name}: 0 PP left, unusable.` : `${mv.name}: ${mv.type} move, power ${mv.power}, accuracy ${mv.accuracy}%, ${mv.pp} PP left. ${effWord(eff)} against ${b.enemy.types.join('/')}. ${stab ? 'Same-type bonus. ' : ''}${dmg}`;
    actions[key] = () => { if (!select(ctx, 'FIGHT')) return; if (cursorTo(ctx, mv.name)) confirmA(ctx); else tap(ctx, 'B', 20); };
  }

  for (const p of party) {
    if (p.slot === b.player.slot || p.hp === 0) continue;
    const bestEff = Math.max(1, ...p.moves.map((m) => rom.effectiveness(m.type, b.enemy.types)));
    const threat = Math.max(...b.enemy.types.map((t) => rom.effectiveness(t, p.types)));
    const key = `Switch to ${p.nickname}`;
    opts[key] = `Switch to ${p.nickname} (${p.species} Lv${p.level}, ${p.types.join('/')}, HP ${p.hp}/${p.maxHp}). Its best move is ${effWord(bestEff)} vs the enemy; enemy's type is ${effWord(threat)} against it. Switching uses the turn.`;
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
    if (/BALL$/.test(it.name) && b.kind === 'wild') {
      const key = `Throw ${it.name}`;
      const dex = [...rom.species.values()].find((sp) => sp.name === b.enemy.species)?.dex ?? 0;
      const isNew = dex && !gs.owned(dex) ? `NEW species you don't own yet. ` : 'You already own this species. ';
      const small = party.length < 3 ? `Your team has only ${party.length} Pokémon — catching adds a team member. ` : '';
      const pc = Math.round(100 * catchChance(it.name, b.enemy.catchRate, b.enemy.hp, b.enemy.maxHp, b.enemy.status));
      opts[key] = `Estimated catch chance ~${pc}% per ${it.name} right now. ${isNew}${small}Try to catch the wild ${b.enemy.species} (Lv${b.enemy.level}, ${b.enemy.types.join('/')}, catch rate ${b.enemy.catchRate}/255, HP ${b.enemy.hp}/${b.enemy.maxHp}, status ${b.enemy.status}). Lower HP and sleep/paralysis make catching easier. Party size ${party.length}/6. ${it.qty} left.`;
      actions[key] = () => { if (!select(ctx, 'ITEM')) return; if (cursorTo(ctx, it.name)) confirmA(ctx); else tap(ctx, 'B', 20); };
    }
  }

  if (b.kind === 'wild') {
    opts['Run away'] = `Flee from the wild ${b.enemy.species}. Speed ${me.spd} vs enemy ${foe.spd}${me.spd >= foe.spd ? ' (escape guaranteed)' : ' (may fail)'}. No experience gained.`;
    actions['Run away'] = () => select(ctx, 'RUN');
  }

  const state = {
    ...situation(ctx),
    battle: {
      kind: b.kind,
      enemy: { ...b.enemy, speed: foe.spd, attack: foe.atk, defense: foe.def, special: foe.spc },
      enemyTrainerPokemonCount: b.kind === 'trainer' ? b.enemyPartyCount : undefined,
      active: { name: party[b.player.slot]?.nickname, species: b.player.species, level: b.player.level, hp: `${b.player.hp}/${b.player.maxHp}`, status: b.player.status, types: b.player.types, speed: me.spd },
    },
  };
  const goal = b.kind === 'wild' && catching
    ? "The player's current focus is CATCHING new Pokémon: a wild battle is the chance to catch this one (weaken it without knocking it out, then throw balls). Knocking it out means it can't be caught."
    : 'Choose the action most likely to win this battle while avoiding losing your Pokémon.';
  const key = await ctx.jev.choose('battle', { ...state, currentFocus: focus }, `You are in a Pokémon battle. ${goal}`, opts);
  remember(ctx.mem.actions, `battle vs ${b.enemy.species}: ${key}`, 12);
  ctx.log('decision', `battle vs ${b.enemy.species} Lv${b.enemy.level}: ${key}`);
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

export async function battleStep(ctx: Ctx) {
  const s = ctx.gs.screen();
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
