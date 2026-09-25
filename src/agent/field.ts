import type { Ctx } from './context.js';
import { tap } from './context.js';
import { select, cursorTo, cursorToIndex, waitForChange } from './menus.js';

// Mechanical helpers for the START menu. What to use and when is always Jev's call.

export function openStart(ctx: Ctx): boolean {
  for (let i = 0; i < 3; i++) {
    tap(ctx, 'START', 20);
    if (ctx.gs.screen().rows.some((r) => r.includes('EXIT'))) return true;
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
  if (!openStart(ctx) || !select(ctx, 'ITEM')) { closeMenus(ctx); return false; }
  ctx.emu.wait(20);
  if (!cursorTo(ctx, item)) { closeMenus(ctx); return false; }
  const before = ctx.gs.screen().rows.join('');
  tap(ctx, 'A', 4);
  waitForChange(ctx, before, 40);
  if (ctx.gs.screen().rows.some((r) => r.includes('USE'))) select(ctx, 'USE');
  return true;
}

/** Party slot of a Pokémon that knows `move`, or -1. */
export function slotWithMove(ctx: Ctx, move: string): number {
  return ctx.gs.party().findIndex((p) => p.moves.some((m) => m.name === move));
}
