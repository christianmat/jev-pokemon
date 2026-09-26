import { mapName } from '../game/symbols.js';
import { fieldMoveLearners } from './context.js';
import type { Ctx } from './context.js';
import { tap, remember, situation } from './context.js';
import { hopsFromMap, serviceFactsFromMap } from './overworld.js';

// Generic screen-reading helpers for menus. They move a cursor to a label that is ON SCREEN;
// what to pick is always decided elsewhere (by Jev).

const menuRepeats = new Map<string, number>();
/** per menu (by its options): the answer given the last times it was open, and how many times in a row */
const menuHistory = new Map<string, { choice: string; streak: number }>();
/** per menu screen: how many times in a row it was closed without choosing anything */
const menuCloses = new Map<string, number>();

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
const CLOSE_SENTINEL = 'Close this menu';
/** Back in the overworld: menu repeat counts start over (a prompt after every battle isn't a loop). */
export function resetMenuRepeats() { menuRepeats.clear(); }

/** a menu label: a word, "-", or an elevator floor (B1F, 5F) */
const LABEL = /[A-Za-z]{2,}|^-$|^B?\d{1,2}F$/;

export function readMenuOptions(ctx: Ctx): Label[] {
  const s = ctx.gs.screen();
  if (!s.cursor) return [];
  if (isPartyMenu(ctx)) return ctx.gs.party().map((p, i) => ({ text: p.nickname, x: 3, y: i * 2, index: i }));
  const { topY, topX, max } = ctx.gs.menu();
  const clean = (t: string) => t.replace(/[┌─┐│└┘▶▷▼]/g, ' ').replace(/\s{2,}.*$/, '').trim();
  const opts: Label[] = [];
  // Try register layout first (step 2, then 1) — only when the cursor really is in that column (else text
  // drawn behind a small box, like a YES/NO over a patterned floor, gets read instead of the options)
  for (const step of s.cursor.x === topX ? [2, 1] : []) {
    const tmp: Label[] = [];
    for (let i = 0; i <= max && i < 12; i++) {
      const y = topY + i * step;
      if (y >= 18) break;
      const text = clean(s.cells[y].slice(topX + 1).join(''));
      if (text) tmp.push({ text, x: topX + 1, y, index: i });
    }
    const wordy = tmp.every((t) => LABEL.test(t.text));
    if (wordy && tmp.length === max + 1 && new Set(tmp.map((t) => t.text)).size === tmp.length) return tmp;
  }
  // Fallback: rows of the cursor's box, in the cursor column, same spacing as the register layout
  const col = s.cursor.x;
  const inBox = (y: number) => /[│ ▶▷]/.test(s.cells[y][col] ?? '') && !/[─┌└┐┘]/.test(s.cells[y][col] ?? '');
  let top = s.cursor.y, bot = s.cursor.y;
  while (top > 0 && inBox(top - 1)) top--;
  while (bot < 17 && inBox(bot + 1)) bot++;
  for (let y = top; y <= bot; y++) {
    const text = clean(s.cells[y].slice(col + 1).join(''));
    if (text && LABEL.test(text)) opts.push({ text, x: col + 1, y });
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
  let opts = readMenuOptions(ctx);
  // "Bring out which POKéMON?" in battle: fainted Pokémon can't be sent out, so they aren't options
  if (ctx.gs.inBattle && isPartyMenu(ctx)) {
    // (nor the one already out: "already in battle" just brings the menu back)
    const active = ctx.gs.battle().player?.slot;
    const activeUp = active !== undefined && (ctx.gs.party()[active]?.hp ?? 0) > 0;
    const alive = opts.filter((o) => (ctx.gs.party()[o.index ?? -1]?.hp ?? 1) > 0 && !(activeUp && o.index === active));
    if (alive.length) opts = alive;
  }
  if (!opts.length) return null;
  // Party screen for an item/TM: the game marks each Pokémon ABLE / NOT ABLE. If nobody is able, back out.
  const ableRows = isPartyMenu(ctx) ? ctx.gs.party().map((_, i) => ctx.gs.screen().rows[i * 2 + 1] ?? '') : [];
  const ableInfo = ableRows.some((r) => /ABLE/.test(r));
  if (ableInfo && ableRows.every((r) => /NOT ABLE/.test(r))) {
    for (let i = 0; i < 3 && ctx.gs.screen().cursor; i++) tap(ctx, 'B', 15);
    ctx.log('info', 'no Pokémon can use this item → backed out');
    return 'CANCEL';
  }
  // House rule: every caught Pokémon gets a nickname (Jev spells it letter by letter on the keyboard). Always answer YES.
  if (/nickname/i.test(ctx.gs.screen().rows.join(' ')) && opts.some((o) => o.text === 'YES')) {
    const yes = opts.find((o) => o.text === 'YES')!;
    if (yes.index !== undefined) cursorToIndex(ctx, yes.index);
    confirmA(ctx);
    ctx.log('info', 'nickname prompt → YES (house rule)');
    return 'YES';
  }
  // loop guard for PC sessions: 15 menu choices with no change to team, box or bag -> log off
  // any menu inside a Pokémon Center counts (also a session resumed after a restart)
  const pc = /POKECENTER/.test(ctx.gs.mapName) && !ctx.gs.inBattle ? (ctx.mem.pcSession ??= { steps: 0, sig: '' }) : ctx.mem.pcSession;
  if (pc) {
    const sig = `${ctx.gs.party().map((p) => p.species + p.level).join(',')}|${ctx.gs.box().map((b) => b.species).join(',')}|${ctx.gs.bag().map((i) => i.name + i.qty).join(',')}`;
    if (sig !== pc.sig) { pc.sig = sig; pc.steps = 0; }
    if (++pc.steps > 15) {
      ctx.log('info', 'PC: 15 menu choices with nothing changed → logging off');
      for (let i = 0; i < 12 && (ctx.gs.screen().cursor || ctx.gs.screen().hasTextBox); i++) tap(ctx, 'B', 20);
      ctx.mem.pcDone = true; ctx.mem.pcMode = undefined; ctx.mem.pcSession = undefined;
      return CLOSE_SENTINEL;
    }
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
    // teaching a TM/HM it already knows does nothing (the game still shows ABLE)
    const mv = ableInfo && ctx.mem.lastItem ? ctx.rom.machineMove([...ctx.rom.items].find(([, n]) => n === ctx.mem.lastItem)?.[0] ?? -1) : undefined;
    const knows = mv && p.moves.some((m) => m.name === mv.name);
    const candy = ctx.mem.lastItem === 'RARE CANDY' ? ` Would go from Lv${p.level} to Lv${p.level + 1}.` : '';
    const able = candy || ableInfo ? candy + (!ableInfo ? '' : /NOT ABLE/.test(ableRows[p.slot]) ? ' NOT ABLE to use this item (choosing it does nothing).' : knows ? ` Already knows ${mv!.name}: choosing it does nothing.` : ' Able to use this item.') : '';
    return `${p.species} Lv${p.level}, ${p.types.join('/')}, HP ${p.hp}/${p.maxHp}${p.hp === 0 ? ' (fainted)' : ''}, moves: ${p.moves.map((m) => m.name).join(', ')}.${able}`;
  };
  const MENU_FACTS: Record<string, string> = {
    BUY: 'Opens the shop list to buy items such as Poké Balls and Potions.',
    SELL: 'Sell items from your bag for money.',
    QUIT: 'Leave without doing anything.',
    CANCEL: 'Close this menu without doing anything.',
    HEAL: 'Fully heal the whole party for free.',
  };
  // the price is the first ¥ amount after the item's name (other text can sit in between, e.g. a half-hidden QUIT)
  const price = (label: string) => {
    const i = screenText.indexOf(label);
    if (i < 0 || !/BUY/.test(screenText) || /^(BUY|SELL|QUIT)$/.test(label)) return '';
    const r = screenText.slice(i + label.length).match(/^[^<]{0,40}?<ED>(\d+)/);
    return r ? `Costs ¥${r[1]}.` : '';
  };
  const inBattle = ctx.gs.inBattle !== 0;
  const shopping = /BUY|MONEY/.test(screenText);
  const SHOP_FACTS: [RegExp, string][] = [
    [/BALL$/, 'Catches wild Pokémon.'], [/^POTION$/, 'Heals 20 HP.'], [/^SUPER POTION$/, 'Heals 50 HP.'], [/^HYPER POTION$/, 'Heals 200 HP.'],
    [/^ANTIDOTE$/, 'Cures poison.'], [/^PARLYZ HEAL$/, 'Cures paralysis.'], [/^BURN HEAL$/, 'Cures a burn.'], [/^AWAKENING$/, 'Wakes a sleeping Pokémon.'],
    [/^ICE HEAL$/, 'Cures freezing.'], [/^FULL HEAL$/, 'Cures any status problem.'], [/^REVIVE$/, 'Revives a fainted Pokémon to half HP.'],
    [/^ESCAPE ROPE$/, 'Escapes a cave or dungeon.'], [/REPEL$/, 'Keeps weak wild Pokémon away for a while.'],
  ];
  const bagQty = (label: string) => ctx.gs.bag().find((i) => i.name === label)?.qty ?? 0;
  const itemRule = (label: string) => {
    if (shopping) {
      const f = SHOP_FACTS.find(([re]) => re.test(label))?.[1];
      return f ? `${f} You have ${bagQty(label)}.` : '';
    }
    if (/BALL$/.test(label)) return inBattle ? (ctx.gs.inBattle === 1 ? 'Throws a ball at the wild Pokémon to catch it.' : "Can't be used: trainers' Pokémon can't be caught.") : 'UNUSABLE HERE: balls only work in a wild Pokémon battle. Choosing it does nothing.';
    if (/^(HM|TM)\d\d$/.test(label)) return inBattle ? 'Unusable in battle.' : 'Teaches a move to a Pokémon.';
    return '';
  };
  // item submenu and the TM "Teach X to a POKéMON?" prompt
  MENU_FACTS.USE = 'Use this item now.';
  MENU_FACTS.TOSS = 'Throw this item away (it is gone for good).';
  const teach = screenText.replace(/\s*\/\s*/g, ' ').match(/Teach ([A-Z0-9 .'-]+?) to a POK/);
  if (teach) {
    MENU_FACTS.YES = `Pick a Pokémon to learn ${teach[1]}.`;
    MENU_FACTS.NO = `Don't teach ${teach[1]} now; the TM goes back into the bag.`;
  }
  // what YES/NO does on the move-learning prompts (the game alternates between them until one is YES)
  const flat = screenText.replace(/\s*\/\s*/g, ' ');
  const learn = flat.match(/room for ([A-Z0-9 .'-]+?)\?/) ?? flat.match(/Abandon learning ([A-Z0-9 .'-]+?)\?/);
  if (learn && /move to make room/.test(flat)) {
    MENU_FACTS.YES = `Pick one of the current moves to forget; ${learn[1]} takes its place.`;
    MENU_FACTS.NO = `Don't forget a move; the game then asks whether to give up learning ${learn[1]}.`;
  } else if (learn && /Abandon learning/.test(flat)) {
    MENU_FACTS.YES = `Give up on ${learn[1]} and keep the current four moves.`;
    MENU_FACTS.NO = `Don't give up; the game goes back to asking whether to forget a move to make room for ${learn[1]}.`;
  }
  // BILL's PC: what each mode does, and what's in the box / team for the pick lists
  const PC_FACTS: [RegExp, string][] = [
    [/^WITHDRAW/, `Move a Pokémon from the box to the team (the team holds 6).${ctx.gs.party().length >= 6 ? ' Your team is full (6/6), so nothing can be withdrawn until a team member is deposited.' : ''}${ctx.gs.box().length ? '' : ' The box is empty.'}`],
    [/^DEPOSIT/, 'Move a team member into the box (at least one must stay on the team).'],
    [/^RELEASE/, 'Permanently lets a Pokémon in the box go. It is gone for good.'],
    [/^CHANGE BOX/, 'Switch to another PC box.'],
    [/^SEE YA/, "Leave BILL's PC."],
    [/^LOG OFF/, 'Turn the PC off.'],
    [/^BILL's PC$|^SOMEONE's PC$/, 'Pokémon storage: move Pokémon between the team and the PC box (withdraw / deposit / release).'],
    [/^[A-Z]+'s PC$/, 'Item storage: store and take out items (no Pokémon here).'],
    [/^PROF\.OAK's PC$/, 'Rates your Pokédex progress.'],
    [/^(WITHDRAW|DEPOSIT) ITEM$/, 'Item storage (not Pokémon).'],
    [/^TOSS ITEM$/, 'Throw away a stored item.'],
  ];
  const pcFact = (label: string) => PC_FACTS.find(([re]) => re.test(label))?.[1] ?? '';
  const box = ctx.gs.box();
  const boxFacts = (label: string) => {
    if (ctx.mem.pcMode !== 'WITHDRAW' && ctx.mem.pcMode !== 'RELEASE') return '';
    const [, base, nth] = label.match(/^(.*?)(?: \((\d+)\))?$/) ?? [];
    const m = box.filter((b) => b.nickname === base)[(+nth || 1) - 1];
    return m ? `In the box: ${m.species} Lv${m.level}, ${m.types.join('/')}.` : '';
  };
  // elevator floors: which map the doors will lead to
  const floorFact = (label: string) => {
    if (!/ELEVATOR/.test(ctx.gs.mapName) || !/^B?\d{1,2}F$/.test(label)) return '';
    const served = [...ctx.rom.maps.values()].filter((m) => m.warps.some((w) => w.destMap === ctx.gs.mapId));
    const m = served.find((mm) => mm.name.endsWith(`_${label}`));
    const h = m ? hopsFromMap(m.id, ctx.gs.mapId) : undefined;
    const here = hopsFromMap(ctx.gs.mapId);
    const cmp = h === undefined || here === undefined ? '' : h < here ? ' Leads toward the objective.' : h > here ? ' Leads away from the objective.' : '';
    return m ? `Sets the elevator doors to lead to ${m.name}.${h !== undefined ? ` That floor is ${h} area(s) from the objective (the elevator is ${here ?? '?'}).${cmp}` : ''}${serviceFactsFromMap(m.id, ctx.gs.mapId)}` : '';
  };
  // in a BILL's PC pick list: say what picking a Pokémon does
  const pcListNote = (label: string) => {
    if (!ctx.mem.pcMode || label === 'Close this menu' || /^(CANCEL|STATS|DEPOSIT|WITHDRAW|RELEASE)$/.test(label) || !/^[A-Z]/.test(label)) return '';
    const isMon = party.some((p) => p.nickname === label.replace(/ \(\d+\)$/, '')) || box.some((b) => b.nickname === label.replace(/ \(\d+\)$/, ''));
    if (!isMon) return '';
    const name = label.replace(/ \(\d+\)$/, '');
    if (ctx.mem.pcMode === 'DEPOSIT') {
      // field moves it takes along: whether anyone else on the team still knows them
      const p = party.find((pp) => pp.nickname === name);
      const fm = (p?.moves ?? []).map((m) => m.name).filter((m) => /^(CUT|SURF|STRENGTH|FLY|FLASH)$/.test(m)).map((m) => {
        const others = party.filter((q) => q !== p && q.moves.some((mm) => mm.name === m)).map((q) => q.nickname);
        return others.length ? `${m} (${others.join(', ')} also knows it)` : `${m} (no other team member knows it)`;
      });
      // the field move the objective needs: can this one learn it (now / after evolving)?
      const need = ctx.mem.fieldMoveNeeded;
      const l = need ? fieldMoveLearners(ctx, need) : undefined;
      const evo = l?.afterEvolving.find((t) => t.startsWith(`in the party: ${name} (`));
      const hm = !need || !l ? '' : l.party.some((t) => t.startsWith(`${name} (`)) ? ` Can learn ${need} (the objective needs a team Pokémon that knows it).` : evo ? ` Can't learn ${need} now; ${evo.replace(/^in the party: [^)]*\) /, '')} (the objective needs a team Pokémon that knows ${need}).` : '';
      return `Picking it DEPOSITS it: it leaves your team and goes into the PC box.${fm.length ? ` Knows field moves: ${fm.join(', ')}.` : ''}${hm}`;
    }
    if (ctx.mem.pcMode === 'WITHDRAW') {
      const need = ctx.mem.fieldMoveNeeded;
      const l = need ? fieldMoveLearners(ctx, need) : undefined;
      const hmFact = !need || !l ? '' : l.box.some((t) => t.startsWith(`${name} (`)) ? ` Can learn ${need}.` : (l.afterEvolving.find((t) => t.startsWith(`in the PC box: ${name} (`)) ?? '').replace(/^in the PC box: [^)]*\) /, ` Can't learn ${need} now; `) + (l.afterEvolving.some((t) => t.startsWith(`in the PC box: ${name} (`)) ? '.' : '');
      return `Picking it WITHDRAWS it: it joins your team from the PC box.${hmFact}`;
    }
    return 'Picking it RELEASES it: it is gone for good.';
  };
  for (const o of opts) criteria[o.text] = `Menu option "${o.text}". ${pcListNote(o.text)} ${MENU_FACTS[o.text] ?? ''} ${floorFact(o.text)} ${pcFact(o.text)} ${itemRule(o.text)} ${extraFacts(o.text) || boxFacts(o.text) || partyFacts(o.text)} ${price(o.text)}`.replace(/\s+/g, ' ').trim();
  // Mechanics Jev can always use: scroll a list that has more entries, and back out of any menu.
  const MORE = 'See more items (scroll down)', CLOSE = 'Close this menu';
  // elevator: where the doors lead right now (the game's live warp table)
  const elevatorNow = () => {
    if (!/ELEVATOR/.test(ctx.gs.mapName)) return '';
    const dest = ctx.gs.u8('wWarpEntries', 3);
    const h = hopsFromMap(dest, ctx.gs.mapId);
    return ` The doors currently lead to ${mapName(dest)}${h !== undefined ? ` (${h} areas from the objective)` : ''}.`;
  };
  if (ctx.gs.screen().moreBelow) {
    criteria[MORE] = 'The list has more entries below the ones shown.';
    // elevators: say which floors are further down the list
    if (/ELEVATOR/.test(ctx.gs.mapName)) {
      const shown = new Set(opts.map((o) => o.text));
      const rest = [...ctx.rom.maps.values()].filter((mm) => mm.warps.some((w) => w.destMap === ctx.gs.mapId)).map((mm) => mm.name.replace(/^.*_/, '')).filter((f) => !shown.has(f));
      if (rest.length) criteria[MORE] += ` Further floors: ${rest.map((f) => { const fm = [...ctx.rom.maps.values()].find((mm) => mm.name.endsWith(`_${f}`) && mm.warps.some((w) => w.destMap === ctx.gs.mapId)); const h = fm ? hopsFromMap(fm.id, ctx.gs.mapId) : undefined; const here = hopsFromMap(ctx.gs.mapId); const pc = fm && /POKECENTER/.test(serviceFactsFromMap(fm.id, ctx.gs.mapId)) ? ', toward the nearest Pokémon Center' : ''; return h !== undefined ? `${f} (${h} areas from the objective${here !== undefined && h < here ? ', toward it' : ''}${pc})` : f; }).join(', ')}.`;
    }
  }
  // (not in battle party screens: after a faint the game requires a choice and B does nothing)
  if (!opts.some((o) => /^(CANCEL|EXIT|NO|QUIT)$/.test(o.text)) && !(ctx.gs.inBattle && isPartyMenu(ctx))) criteria[CLOSE] = `Leave this menu without choosing anything (B button).${elevatorNow()}${ctx.mem.pcMode === 'DEPOSIT' && party.length >= 6 && opts.some((o) => party.some((p) => p.nickname === o.text)) ? ' Nobody is deposited: the team stays full (6/6), so nothing can be withdrawn.' : ''}`;
  const seenKey = screenText + '|' + opts.map((o) => o.text).join('|');
  const repeats = (menuRepeats.get(seenKey) ?? 0) + 1;
  menuRepeats.set(seenKey, repeats);
  if (menuRepeats.size > 200) menuRepeats.clear();
  // same menu keeps coming back (the answers aren't getting anywhere): back out of the menus entirely
  if (repeats >= 5) {
    ctx.log('info', `menu came back ${repeats} times → backing out`);
    menuRepeats.delete(seenKey);
    for (let i = 0; i < 10 && (ctx.gs.screen().cursor || ctx.gs.screen().hasTextBox); i++) tap(ctx, 'B', 20);
    // backing out of the PC ends that PC session like logging off does (otherwise the team focus walks right back)
    if (ctx.mem.pcMode || ctx.mem.pcSession) { ctx.mem.pcDone = true; ctx.mem.pcMode = undefined; ctx.mem.pcSession = undefined; }
    return CLOSE;
  }
  const histKey = opts.map((o) => o.text).join('|');
  const hist = menuHistory.get(histKey);
  // only for answers that leave without doing anything (a working answer like BUY isn't a sign of a loop)
  if (hist && hist.streak >= 2 && criteria[hist.choice] && (hist.choice === CLOSE || /^(QUIT|CANCEL|EXIT)$/.test(hist.choice))) criteria[hist.choice] += ` Chosen the last ${hist.streak} times this menu was open.`;
  const focus = ctx.mem.intent?.value;
  const asked = await ctx.jev.chooseP(purpose, { ...situation(ctx), currentFocus: focus, screen: screenText }, `A menu is open on screen.${focus ? ` The player's current focus is: ${focus}.` : ''} Which option best serves that focus and the objective?${/BUY|MONEY/.test(screenText) ? ` Money: ¥${ctx.gs.money}.` : ' Item rule: only use an item where it actually works (Poké Balls only in wild battles, healing items only on hurt Pokémon, TMs/HMs to teach moves outside battle).'} Rule: if this same menu keeps coming back after your answer, your last answer isn't working — choose a different option.${repeats >= 2 ? ` This exact menu has appeared ${repeats} times.` : ''}`, criteria);
  let choice = asked.choice;
  // Loop rule (same as the overworld one): closing this exact menu again and again changes nothing, so after
  // 2 closes in a row, a 3rd close is replaced by one of Jev's other answers, weighted by Jev's own probabilities
  const closeKey = `${screenText}|${histKey}`;
  const closes = choice === CLOSE ? (menuCloses.get(closeKey) ?? 0) + 1 : 0;
  menuCloses.set(closeKey, closes);
  if (menuCloses.size > 300) menuCloses.clear();
  if (closes >= 3 && asked.probabilities) { // (before the 5-repeats back-out can end the menu)
    // never force a hard-to-undo action; in a deposit list only a team member that isn't the strongest, the lead,
    // or the only one knowing a field move (it can be withdrawn again later)
    const top = Math.max(...party.map((p) => p.level));
    const depositOk = (k: string) => {
      const p = party.find((pp) => pp.nickname === k);
      return !!p && p.slot !== 0 && p.level < top && p.hp > 0 && !/no other team member knows it|the objective needs a team Pokémon/.test(criteria[k]);
    };
    const alts = Object.entries(asked.probabilities).filter(([k]) => k !== CLOSE && criteria[k] && (/Picking it DEPOSITS it/.test(criteria[k]) ? depositOk(k) : !/RELEASE|TOSS|SELL|DEPOSIT/i.test(`${k} ${criteria[k]}`)));
    const total = alts.reduce((a, [, p]) => a + p + 0.05, 0);
    let r = Math.random() * total;
    for (const [k, p] of alts) { r -= p + 0.05; if (r <= 0) { choice = k; break; } }
    if (choice !== CLOSE) { ctx.log('info', `menu closed ${closes - 1}x in a row with no change (a 3rd close) → trying "${choice}" instead`); menuCloses.set(closeKey, 0); }
  }
  remember(ctx.mem.actions, `menu[${opts.map((o) => o.text).join('|')}] -> ${choice}`, 12);
  menuHistory.set(histKey, { choice, streak: hist?.choice === choice ? hist.streak + 1 : 1 });
  if (menuHistory.size > 300) menuHistory.clear();
  ctx.log('decision', `menu → ${choice}`, { options: opts.map((o) => o.text) });
  if (/^(TM|HM)\d\d$|^RARE CANDY$/.test(choice)) ctx.mem.lastItem = choice;
  // BILL's PC bookkeeping: which list we're in, and when the PC is left
  const pcMode = choice.match(/^(WITHDRAW|DEPOSIT|RELEASE)/)?.[1];
  if (pcMode && opts.some((o) => /^SEE YA/.test(o.text))) ctx.mem.pcMode = pcMode;
  // leaving the PC (LOG OFF / SEE YA!, or closing its top menu with B) ends a 'team' focus
  if (/^(SEE YA|LOG OFF)/.test(choice) || (choice === CLOSE && opts.some((o) => /^LOG OFF/.test(o.text)))) { ctx.mem.pcDone = true; ctx.mem.pcMode = undefined; }
  // leaving a shop counter (BUY/SELL/QUIT) ends a 'shop' focus, like leaving the Mart does
  if (choice === 'QUIT' && opts.some((o) => o.text === 'BUY')) ctx.mem.shopDone = true;
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
