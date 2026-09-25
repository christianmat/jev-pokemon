import type { Ctx } from './context.js';
import { tap, remember, rememberDialog } from './context.js';
import { decideMenu, findLabel, cursorTo } from './menus.js';
import { decode } from '../game/text.js';
import { sym } from '../game/symbols.js';

const NAME = process.env.PLAYER_NAME ?? 'JEV';
const RIVAL = process.env.RIVAL_NAME ?? 'BLUE';

export function isNamingScreen(ctx: Ctx): boolean {
  const rows = ctx.gs.screen().rows;
  return rows.some((r) => /A B C D E F G H I/.test(r.replace(/[▶▷]/g, ' ')));
}

/** Types a name on the naming keyboard by reading letter positions off the screen. */
export function typeName(ctx: Ctx, name: string) {
  const rows = () => ctx.gs.screen().rows;
  // Only type if the name field is empty (otherwise accept what's there)
  const nameRow = rows().findIndex((r) => /NAME\?/.test(r));
  const typed = nameRow >= 0 ? rows()[nameRow + 1]?.trim() ?? '' : '';
  if (typed.replace(/[_\s]/g, '')) { tap(ctx, 'START', 20); return; }
  for (const ch of name) {
    for (let i = 0; i < 20; i++) {
      const s = ctx.gs.screen();
      let pos: { x: number; y: number } | null = null;
      for (let y = 4; y < 16 && !pos; y++) {
        for (let x = 0; x < 20; x++) if (s.rows[y][x] === ch && (x === 0 || s.rows[y][x - 1] !== ch)) { pos = { x, y }; break; }
      }
      const cur = s.cursor;
      if (!pos || !cur) break;
      if (cur.y === pos.y && cur.x === pos.x - 1) { tap(ctx, 'A', 8); break; }
      if (cur.y > pos.y) tap(ctx, 'UP', 6);
      else if (cur.y < pos.y) tap(ctx, 'DOWN', 6);
      else if (cur.x > pos.x - 1) tap(ctx, 'LEFT', 6);
      else tap(ctx, 'RIGHT', 6);
    }
  }
  tap(ctx, 'START', 30);
}

const MAX_NICK = 10;
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

/** Jev picks a nickname letter by letter (A–Z or DONE), then it's typed on the keyboard. */
export async function spellNickname(ctx: Ctx) {
  const rows = ctx.gs.screen().rows;
  const species = (rows.find((r) => /NICKNAME/.test(r)) ?? '').replace(/'S.*$|NICKNAME.*$/i, '').replace(/[^A-Z0-9♂♀.\- ]/g, '').trim() || 'the new Pokémon';
  // the name must be made up: not a species name, not a nickname already in use (party or current PC box)
  const taken = new Set<string>([...ctx.rom.species.values()].map((sp) => sp.name));
  for (const p of ctx.gs.party()) taken.add(p.nickname);
  const boxCount = Math.min(ctx.gs.u8('wBoxCount'), 20);
  for (let i = 0; i < boxCount; i++) taken.add(decode(ctx.emu.mem, sym('wBoxMonNicks') + i * 11, 11));
  let name = '';
  for (let guard = 0; guard < 40 && name.length <= MAX_NICK; guard++) {
    if (name.length === MAX_NICK) { if (!taken.has(name)) break; name = name.slice(0, -1); } // full but taken: change the end
    const options: Record<string, string> = {};
    for (const l of LETTERS) options[l] = `Name becomes "${name}${l}".${taken.has(name + l) ? ' That is an existing Pokémon name or nickname, so it cannot be the final name.' : ''}`;
    if (name && !taken.has(name)) options.DONE = `Finish: the nickname is "${name}".`;
    const pick = await ctx.jev.choose('nickname', { species, nameSoFar: name, lettersLeft: MAX_NICK - name.length },
      `Give ${species} a nickname, one letter at a time. Rule: it must be a new, made-up name, not the name of any Pokémon species and not a nickname already in use. Name so far: "${name}". Pick the next letter${options.DONE ? ', or DONE to finish' : ''}. Up to ${MAX_NICK} letters.`, options);
    if (pick === 'DONE') break;
    if (LETTERS.includes(pick)) name += pick;
  }
  if (!name || taken.has(name)) name = (name || 'X').slice(0, MAX_NICK - 1) + 'X'; // safety net, should not happen
  ctx.log('info', `nickname → ${name}`);
  typeName(ctx, name);
}

/** Advances dialog text; delegates on-screen menus to Jev. */
export async function dialogStep(ctx: Ctx, purpose = 'dialog-menu') {
  const s = ctx.gs.screen();
  if (isNamingScreen(ctx)) {
    // Pokémon nickname: Jev spells it one letter at a time
    if (s.rows.some((r) => /NICKNAME/.test(r))) { await spellNickname(ctx); return; }
    const rival = s.rows.some((r) => /RIVAL/.test(r));
    const nm = rival ? RIVAL : NAME;
    ctx.log('info', `naming screen → typing ${nm} (or keeping default)`);
    typeName(ctx, nm);
    return;
  }
  if (s.dialog) {
    rememberDialog(ctx.mem, s.dialog);
    const k = ctx.mem.lastInteraction;
    if (k) {
      // only what was said since this interaction started is attributed to this person/sign
      const talk = (ctx.mem.currentTalk ??= []);
      const line = ctx.mem.dialog[ctx.mem.dialog.length - 1];
      if (line && talk[talk.length - 1] !== line) {
        if (talk.length && line.startsWith(talk[talk.length - 1])) talk[talk.length - 1] = line; else talk.push(line);
      }
      ctx.mem.npcText[k] = talk.join(' ').slice(-1500);
      // a reset puzzle (e.g. electric locks) makes what other objects here showed before out of date
      if (/were reset/.test(line ?? '')) {
        const prefix = k.slice(0, k.indexOf(':hidden') + 7);
        if (prefix.endsWith(':hidden')) for (const o of Object.keys(ctx.mem.npcText)) if (o !== k && o.startsWith(prefix)) delete ctx.mem.npcText[o];
      }
    }
  }
  // Options screen: configure once (fast text, no battle animations), then leave.
  if (findLabel(ctx, 'TEXT SPEED') && findLabel(ctx, 'BATTLE')) {
    if ((ctx.gs.u8('wOptions') & 0x8f) !== 0x81) {
      ctx.emu.wait(30);
      for (const b of ['LEFT', 'LEFT', 'DOWN', 'RIGHT'] as const) tap(ctx, b, 10);
      ctx.log('info', `options set (text FAST, animations OFF): ${ctx.gs.u8('wOptions').toString(16)}`);
    }
    tap(ctx, 'B', 40);
    return;
  }
  if (findLabel(ctx, 'NEW GAME') && findLabel(ctx, 'OPTION') && (ctx.gs.u8('wOptions') & 0x8f) !== 0x81) {
    ctx.log('info', 'configuring game options before starting');
    if (cursorTo(ctx, 'OPTION')) tap(ctx, 'A', 40);
    return;
  }
  if (s.cursor && !s.waitingForA) {
    // Start menu opened by accident (we never open it without intent) → close it
    if (findLabel(ctx, 'POKéDEX') && findLabel(ctx, 'EXIT') || findLabel(ctx, 'SAVE') && findLabel(ctx, 'OPTION') && findLabel(ctx, 'EXIT')) {
      tap(ctx, 'B', 10);
      return;
    }
    const picked = await decideMenu(ctx, purpose);
    if (picked) return;
  }
  advanceText(ctx);
}

/** Press A to advance, then let text print until a prompt/menu shows or the box closes. */
export function advanceText(ctx: Ctx, maxFrames = 150) {
  tap(ctx, 'A', 4);
  for (let i = 0; i < maxFrames; i++) {
    const s = ctx.gs.screen();
    if (s.waitingForA || s.cursor || !s.hasTextBox) return;
    ctx.emu.frame();
  }
}
