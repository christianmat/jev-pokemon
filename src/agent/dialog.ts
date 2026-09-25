import type { Ctx } from './context.js';
import { tap, remember, rememberDialog } from './context.js';
import { decideMenu, findLabel, cursorTo } from './menus.js';

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

/** Advances dialog text; delegates on-screen menus to Jev. */
export async function dialogStep(ctx: Ctx, purpose = 'dialog-menu') {
  const s = ctx.gs.screen();
  if (isNamingScreen(ctx)) {
    // Pokémon nickname: Jev can't type free text, so keep the species name
    if (s.rows.some((r) => /NICKNAME/.test(r))) { ctx.log('info', 'nickname screen → keeping species name'); tap(ctx, 'START', 30); return; }
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
