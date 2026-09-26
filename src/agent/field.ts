import type { Ctx } from './context.js';
import { tap } from './context.js';
import { select, cursorTo, cursorToIndex, waitForChange } from './menus.js';

// Mechanical helpers for the START menu. What to use and when is always Jev's call.

export function openStart(ctx: Ctx): boolean {
  const open = () => ctx.gs.screen().rows.some((r) => r.includes('EXIT'));
  for (let i = 0; i < 3; i++) {
    tap(ctx, 'START', 20);
    // the menu takes a moment to draw: wait for it before pressing START again (that would close it)
    for (let f = 0; f < 90 && !open(); f += 5) ctx.emu.wait(5);
    if (open()) return true;
    if (ctx.gs.screen().nonMapTiles > 0) { tap(ctx, 'B', 20); ctx.emu.wait(20); } // something else opened: back out first
  }
  return false;
}

export function closeMenus(ctx: Ctx) {
  for (let i = 0; i < 6 && ctx.gs.screen().nonMapTiles > 0; i++) tap(ctx, 'B', 12);
}

/** START → POKéMON → slot → field move (CUT/SURF/STRENGTH/FLASH/...). */
export function useFieldMove(ctx: Ctx, slot: number, move: string): boolean {
  if (!openStart(ctx) || !select(ctx, 'POKéMON')) { closeMenus(ctx); return false; }
  ctx.emu.wait(20);
  if (!cursorToIndex(ctx, slot)) { closeMenus(ctx); return false; }
  const before = ctx.gs.screen().rows.join('');
  tap(ctx, 'A', 4);
  waitForChange(ctx, before, 40);
  if (!select(ctx, move)) { closeMenus(ctx); return false; }
  ctx.emu.wait(30);
  return true;
}

/** START → ITEM → item → USE. Follow-up prompts (which Pokémon, forget which move...) go through the normal Jev menu loop. */
export function useItem(ctx: Ctx, item: string): boolean {
  ctx.mem.lastItem = item;
  if (!openStart(ctx) || !select(ctx, 'ITEM')) { closeMenus(ctx); return false; }
  ctx.emu.wait(20);
  if (!cursorTo(ctx, item)) { closeMenus(ctx); return false; }
  // the USE / TOSS box takes a moment to appear (key items skip it)
  const box = () => ctx.gs.screen().rows.some((r) => r.includes('TOSS'));
  openItemBox(ctx, box);
  if (box()) select(ctx, 'USE');
  return true;
}

/** Press A on the highlighted bag item until its USE/TOSS box shows (the list ignores A for a moment after drawing). */
function openItemBox(ctx: Ctx, box: () => boolean) {
  ctx.emu.wait(20);
  for (let tries = 0; tries < 2 && !box(); tries++) {
    const before = ctx.gs.screen().rows.join('');
    tap(ctx, 'A', 4);
    for (let f = 0; f < 90 && !box(); f += 5) { ctx.emu.wait(5); if (ctx.gs.screen().rows.join('') !== before && !box() && f > 60) break; }
  }
}

/** Open the bag on an item and choose TOSS with quantity 1; the game's "Is it OK to toss" YES/NO is left for Jev. */
export function tossItem(ctx: Ctx, item: string): boolean {
  if (!openStart(ctx) || !select(ctx, 'ITEM')) { closeMenus(ctx); return false; }
  ctx.emu.wait(20);
  if (!cursorTo(ctx, item)) { closeMenus(ctx); return false; }
  const box = () => ctx.gs.screen().rows.some((r) => r.includes('TOSS'));
  openItemBox(ctx, box);
  if (!box() || !select(ctx, 'TOSS')) { closeMenus(ctx); return false; }
  ctx.emu.wait(20);
  tap(ctx, 'A', 20); // quantity ×1
  return true;
}

/** Party slot of a Pokémon that knows `move`, or -1. */
export function slotWithMove(ctx: Ctx, move: string): number {
  return ctx.gs.party().findIndex((p) => p.moves.some((m) => m.name === move));
}
