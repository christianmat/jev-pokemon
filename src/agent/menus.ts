import type { Ctx } from './context.js';
import { tap, remember, situation } from './context.js';

// Generic screen-reading helpers for menus. They move a cursor to a label that is ON SCREEN;
// what to pick is always decided elsewhere (by Jev).

const menuRepeats = new Map<string, number>();

export interface Label { text: string; x: number; y: number; index?: number }

/** Party menu: names on rows 0,2,4.. with the cursor on the row below each name. */
export function isPartyMenu(ctx: Ctx): boolean {
  const s = ctx.gs.screen();
  const party = ctx.gs.party();
  return !!s.cursor && s.cursor.x === 0 && party.length > 0 && s.rows[0].slice(3).startsWith(party[0].nickname);
}

/** Move the menu cursor to a list index using the game's own cursor register. */
export function cursorToIndex(ctx: Ctx, index: number): boolean {
  for (let i = 0; i < 20; i++) {
    const cur = ctx.gs.menu().current;
    if (cur === index) return true;
    tap(ctx, cur > index ? 'UP' : 'DOWN', 6);
  }
  return ctx.gs.menu().current === index;
}

/** Finds `text` on screen; with several matches, prefers the one closest to the cursor. */
export function findLabel(ctx: Ctx, text: string): Label | null {
  const s = ctx.gs.screen();
  const want = text.toUpperCase();
  const hits: Label[] = [];
  for (let y = 0; y < s.rows.length; y++) {
    const row = s.rows[y].toUpperCase();
    for (let i = row.indexOf(want); i >= 0; i = row.indexOf(want, i + 1)) hits.push({ text, x: i, y });
  }
  if (!hits.length) return null;
  const c = s.cursor ?? { x: 0, y: 17 };
  hits.sort((a, b) => Math.abs(a.y - c.y) * 4 + Math.abs(a.x - c.x) - (Math.abs(b.y - c.y) * 4 + Math.abs(b.x - c.x)));
  return hits[0];
}

/** Moves the ▶ cursor next to `text` (scrolling down if needed). Returns false if not reachable. */
export function cursorTo(ctx: Ctx, text: string, maxPresses = 30): boolean {
  let scrolled = 0, waited = 0;
  for (let i = 0; i < maxPresses; i++) {
    const s = ctx.gs.screen();
    const cur = s.cursor;
    const lab = findLabel(ctx, text);
    if (!cur) { ctx.emu.wait(4); continue; }
    if (!lab) {
      // give the menu time to draw, then assume a scrolling list
      if (waited < 45) { waited += 5; ctx.emu.wait(5); i--; continue; }
      if (scrolled++ > 25) return false;
      tap(ctx, 'DOWN', 6);
      continue;
    }
    const tx = lab.x - 1;
    if (cur.y === lab.y && Math.abs(cur.x - tx) <= 1) return true;
    if (cur.y > lab.y) tap(ctx, 'UP', 6);
    else if (cur.y < lab.y) tap(ctx, 'DOWN', 6);
    else if (cur.x > tx) tap(ctx, 'LEFT', 6);
    else tap(ctx, 'RIGHT', 6);
  }
  return false;
}

export function select(ctx: Ctx, text: string): boolean {
  if (!cursorTo(ctx, text)) return false;
  return confirmA(ctx);
}

/** Reads the options of the menu that currently owns the ▶ cursor. */
export function readMenuOptions(ctx: Ctx): Label[] {
  const s = ctx.gs.screen();
  if (!s.cursor) return [];
  if (isPartyMenu(ctx)) return ctx.gs.party().map((p, i) => ({ text: p.nickname, x: 3, y: i * 2, index: i }));
  const { topY, topX, max } = ctx.gs.menu();
  const clean = (t: string) => t.replace(/[┌─┐│└┘▶▷▼]/g, ' ').replace(/\s{2,}.*$/, '').trim();
  const opts: Label[] = [];
  // Try register layout first (step 2, then 1)
  for (const step of [2, 1]) {
    const tmp: Label[] = [];
    for (let i = 0; i <= max && i < 12; i++) {
      const y = topY + i * step;
      if (y >= 18) break;
      const text = clean(s.rows[y].slice(topX + 1));
      if (text) tmp.push({ text, x: topX + 1, y, index: i });
    }
    const wordy = tmp.every((t) => /[A-Za-z]{2,}|^-$/.test(t.text));
    if (wordy && tmp.length === max + 1 && new Set(tmp.map((t) => t.text)).size === tmp.length) return tmp;
  }
  // Fallback: rows of the cursor's box, in the cursor column, same spacing as the register layout
  const col = s.cursor.x;
  const inBox = (y: number) => /[│ ▶▷]/.test(s.rows[y][col] ?? '') && !/[─┌└┐┘]/.test(s.rows[y][col] ?? '');
  let top = s.cursor.y, bot = s.cursor.y;
  while (top > 0 && inBox(top - 1)) top--;
  while (bot < 17 && inBox(bot + 1)) bot++;
  for (let y = top; y <= bot; y++) {
    const text = clean(s.rows[y].slice(col + 1));
    if (text && /[A-Za-z]{2,}|^-$/.test(text)) opts.push({ text, x: col + 1, y });
  }
  return opts;
}

/** Ask Jev which option of the current on-screen menu to pick, then pick it. */
export async function decideMenu(ctx: Ctx, purpose: string, extraFacts: (label: string) => string = () => ''): Promise<string | null> {
  // wait for the screen to settle (text still printing next to the menu)
  let last = '', stable = 0;
  for (let f = 0; f < 120 && stable < 8; f++) {
    const now = ctx.gs.screen().rows.join('');
    stable = now === last ? stable + 1 : 0;
    last = now;
    ctx.emu.frame();
  }
  const opts = readMenuOptions(ctx);
  if (!opts.length) return null;
  // Party screen for an item/TM: the game marks each Pokémon ABLE / NOT ABLE. If nobody is able, back out.
  const ableRows = isPartyMenu(ctx) ? ctx.gs.party().map((_, i) => ctx.gs.screen().rows[i * 2 + 1] ?? '') : [];
  const ableInfo = ableRows.some((r) => /ABLE/.test(r));
  if (ableInfo && ableRows.every((r) => /NOT ABLE/.test(r))) {
    for (let i = 0; i < 3 && ctx.gs.screen().cursor; i++) tap(ctx, 'B', 15);
    ctx.log('info', 'no Pokémon can use this item → backed out');
    return 'CANCEL';
  }
  // House rule: never nickname Pokémon (Jev can't type names). Always answer NO.
  if (/nickname/i.test(ctx.gs.screen().rows.join(' ')) && opts.some((o) => o.text === 'NO')) {
    const no = opts.find((o) => o.text === 'NO')!;
    if (no.index !== undefined) cursorToIndex(ctx, no.index);
    confirmA(ctx);
    ctx.log('info', 'nickname prompt → NO (house rule)');
    return 'NO';
  }
  // make option keys unique (e.g. several "-" move slots)
  const seenText = new Map<string, number>();
  for (const o of opts) { const n = (seenText.get(o.text) ?? 0) + 1; seenText.set(o.text, n); if (n > 1) o.text = `${o.text} (${n})`; }
  const s = ctx.gs.screen();
  const screenText = s.rows.map((r) => r.replace(/[┌─┐│└┘]/g, ' ').trim()).filter(Boolean).join(' / ');
  const criteria: Record<string, string> = {};
  const party = ctx.gs.party();
  const partyFacts = (label: string) => {
    const p = party.find((pp) => pp.nickname === label);
    if (!p) return '';
    const able = ableInfo ? (/NOT ABLE/.test(ableRows[p.slot]) ? ' NOT ABLE to use this item (choosing it does nothing).' : ' Able to use this item.') : '';
    return `${p.species} Lv${p.level}, ${p.types.join('/')}, HP ${p.hp}/${p.maxHp}${p.hp === 0 ? ' (fainted)' : ''}, moves: ${p.moves.map((m) => m.name).join(', ')}.${able}`;
  };
  const MENU_FACTS: Record<string, string> = {
    BUY: 'Opens the shop list to buy items such as Poké Balls and Potions.',
    SELL: 'Sell items from your bag for money.',
    QUIT: 'Leave without doing anything.',
    CANCEL: 'Close this menu without doing anything.',
    HEAL: 'Fully heal the whole party for free.',
  };
  const price = (label: string) => { const r = screenText.match(new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*/\\s*<ED>(\\d+)')); return r ? `Costs ¥${r[1]}.` : ''; };
  const inBattle = ctx.gs.inBattle !== 0;
  const shopping = /BUY|MONEY/.test(screenText);
  const itemRule = (label: string) => {
    if (shopping) return '';
    if (/BALL$/.test(label)) return inBattle ? (ctx.gs.inBattle === 1 ? 'Throws a ball at the wild Pokémon to catch it.' : "Can't be used: trainers' Pokémon can't be caught.") : 'UNUSABLE HERE: balls only work in a wild Pokémon battle. Choosing it does nothing.';
    if (/^(HM|TM)\d\d$/.test(label)) return inBattle ? 'Unusable in battle.' : 'Teaches a move to a Pokémon.';
    return '';
  };
  for (const o of opts) criteria[o.text] = `Menu option "${o.text}". ${MENU_FACTS[o.text] ?? ''} ${itemRule(o.text)} ${extraFacts(o.text) || partyFacts(o.text)} ${price(o.text)}`.replace(/\s+/g, ' ').trim();
  // Mechanics Jev can always use: scroll a list that has more entries, and back out of any menu.
  const MORE = 'See more items (scroll down)', CLOSE = 'Close this menu';
  if (ctx.gs.screen().moreBelow) criteria[MORE] = 'The list has more entries below the ones shown.';
  // (not in battle party screens: after a faint the game requires a choice and B does nothing)
  if (!opts.some((o) => /^(CANCEL|EXIT|NO|QUIT)$/.test(o.text)) && !(ctx.gs.inBattle && isPartyMenu(ctx))) criteria[CLOSE] = 'Leave this menu without choosing anything (B button).';
  const seenKey = screenText + '|' + opts.map((o) => o.text).join('|');
  const repeats = (menuRepeats.get(seenKey) ?? 0) + 1;
  menuRepeats.set(seenKey, repeats);
  if (menuRepeats.size > 200) menuRepeats.clear();
  const prevExplore = ctx.jev.explore;
  if (repeats >= 3) ctx.jev.explore = true; // same menu keeps coming back → sample instead of repeating
  const focus = ctx.mem.intent?.value;
  const choice = await ctx.jev.choose(purpose, { ...situation(ctx), currentFocus: focus, screen: screenText }, `A menu is open on screen.${focus ? ` The player's current focus is: ${focus}.` : ''} Which option best serves that focus and the objective? Item rule: only use an item where it actually works (Poké Balls only in wild battles, healing items only on hurt Pokémon, TMs/HMs to teach moves outside battle); if nothing here is useful, pick CANCEL/EXIT. Rule: if this same menu keeps coming back after your answer, your last answer isn't working — choose a different option.${repeats >= 2 ? ` This exact menu has appeared ${repeats} times.` : ''}`, criteria);
  ctx.jev.explore = prevExplore;
  remember(ctx.mem.actions, `menu[${opts.map((o) => o.text).join('|')}] -> ${choice}`, 12);
  ctx.log('decision', `menu → ${choice}`, { options: opts.map((o) => o.text) });
  if (choice === MORE) { for (let i = 0; i <= ctx.gs.menu().max; i++) tap(ctx, 'DOWN', 6); return choice; }
  if (choice === CLOSE) { tap(ctx, 'B', 15); return choice; }
  const target = opts.find((o) => o.text === choice)!;
  if (target.index !== undefined && cursorToIndex(ctx, target.index)) {
    confirmA(ctx);
    return choice;
  }
  // move by rows (menu option labels can repeat across the screen)
  for (let i = 0; i < 20; i++) {
    const cur = ctx.gs.screen().cursor;
    if (!cur) break;
    if (cur.y === target.y && Math.abs(cur.x - (target.x - 1)) <= 1) break;
    if (cur.y > target.y) tap(ctx, 'UP', 6);
    else if (cur.y < target.y) tap(ctx, 'DOWN', 6);
    else if (cur.x > target.x - 1) tap(ctx, 'LEFT', 6);
    else tap(ctx, 'RIGHT', 6);
  }
  confirmA(ctx);
  return choice;
}

/** Press A and verify the screen reacted; retry a few times (some menus drop early presses). */
export function confirmA(ctx: Ctx, tries = 3): boolean {
  for (let i = 0; i < tries; i++) {
    const before = ctx.gs.screen().rows.join('') + JSON.stringify(ctx.gs.screen().cursor);
    tap(ctx, 'A', 4);
    for (let f = 0; f < 40; f++) {
      const now = ctx.gs.screen().rows.join('') + JSON.stringify(ctx.gs.screen().cursor);
      if (now !== before || ctx.gs.inBattle === 0 && f > 30) { ctx.emu.wait(4); return true; }
      ctx.emu.frame();
    }
  }
  return false;
}

/** Wait until the tilemap differs from `before` (menu closed / next screen drawn). */
export function waitForChange(ctx: Ctx, before: string, maxFrames: number) {
  for (let i = 0; i < maxFrames; i++) {
    if (ctx.gs.screen().rows.join('') !== before) { ctx.emu.wait(4); return; }
    ctx.emu.frame();
  }
}
