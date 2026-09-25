import fs from 'node:fs';
import type { Ctx } from './context.js';
import { tap, remember } from './context.js';
import { dialogStep, isNamingScreen } from './dialog.js';
import { overworldStep } from './overworld.js';
import { battleStep } from './battle.js';
import { sym } from '../game/symbols.js';
import { currentMilestone, markVisited, MILESTONES, visitedMaps, restoreVisited } from '../knowledge/milestones.js';

const STUCK_EXPLORE = +(process.env.STUCK_EXPLORE ?? 30);
const STUCK_RELOAD = +(process.env.STUCK_RELOAD ?? 250);

export type Mode = 'battle' | 'dialog' | 'overworld' | 'busy' | 'boot';

export class Agent {
  milestoneIndex = -1;
  decisionsSinceProgress = 0;
  private lastProgressKey = '';
  private lastMap = -1;
  stopped = false;

  constructor(private ctx: Ctx, private saveDir = 'saves') {}

  mode(): Mode {
    const { gs } = this.ctx;
    if (gs.inBattle) return 'battle';
    const s = gs.screen();
    if (s.hasTextBox || s.cursor || isNamingScreen(this.ctx)) return 'dialog';
    // cutscene / scripted movement: directions ignored or simulated joypad active
    if ((gs.joyIgnore & 0xf0) || (gs.u8('wStatusFlags5') & 0x80) || this.ctx.emu.mem[sym('wWalkCounter')] !== 0) return 'busy';
    if (this.ctx.emu.mem[0xc100] !== 0 && gs.mapWidth > 0 && s.nonMapTiles === 0) return 'overworld';
    if (s.nonMapTiles > 0) return 'dialog'; // full-screen UI (Pokédex page, etc.)
    return 'boot';
  }

  async step() {
    const { ctx } = this;
    const mode = this.mode();
    this.track();
    switch (mode) {
      case 'battle': await battleStep(ctx); break;
      case 'dialog': await dialogStep(ctx); break;
      case 'overworld': this.unstick(); await overworldStep(ctx, this); break;
      case 'busy': ctx.emu.wait(8); break;
      case 'boot': tap(ctx, 'A', 20); break;
    }
  }

  /** Progress + milestone bookkeeping, autosave on milestone. */
  private track() {
    const { gs, mem } = this.ctx;
    if (this.mode() === 'overworld' && gs.mapId !== this.lastMap) {
      this.lastMap = gs.mapId;
      mem.visitedMaps[gs.mapName] = (mem.visitedMaps[gs.mapName] ?? 0) + 1;
      markVisited(gs.mapName);
      this.ctx.log('map', `entered ${gs.mapName}`);
    }
    const { index, m } = currentMilestone(gs);
    if (index !== this.milestoneIndex) {
      if (this.milestoneIndex >= 0 && index > this.milestoneIndex) {
        this.ctx.log('milestone', `✔ ${MILESTONES[this.milestoneIndex].id} complete → next: ${m?.id ?? 'DONE'}`);
        this.save(`milestone-${String(index).padStart(2, '0')}-${MILESTONES[index - 1].id}`);
      }
      this.milestoneIndex = index;
    }
    const key = `${index}|${Object.keys(mem.visitedMaps).length}|${gs.badges}|${gs.party().length}|${mem.bestHops?.[index] ?? ''}`;
    if (key !== this.lastProgressKey) { this.lastProgressKey = key; this.decisionsSinceProgress = 0; mem.triedNoProgress = {}; }
  }

  /** Loop protection: explore (sample Jev's distribution) when stuck; reload a checkpoint if badly stuck. */
  private unstick() {
    const n = this.decisionsSinceProgress;
    const explore = n >= STUCK_EXPLORE;
    if (explore !== this.ctx.jev.explore) {
      this.ctx.jev.explore = explore;
      this.ctx.log('info', explore ? `no progress for ${n} decisions → sampling from Jev's distribution` : 'progress made → back to argmax');
    }
    if (n >= STUCK_RELOAD) {
      const last = fs.existsSync(`${this.saveDir}/latest.txt`) ? fs.readFileSync(`${this.saveDir}/latest.txt`, 'utf8').trim() : null;
      if (last && last.startsWith('milestone')) {
        this.ctx.log('warn', `stuck for ${n} decisions → reloading ${last}`);
        this.load(last);
      }
      this.decisionsSinceProgress = 0;
    }
  }

  save(name: string) {
    fs.mkdirSync(this.saveDir, { recursive: true });
    const file = `${this.saveDir}/${name}.state.json`;
    this.ctx.emu.saveState(file);
    fs.writeFileSync(`${this.saveDir}/${name}.memory.json`, JSON.stringify({ mem: { ...this.ctx.mem, stepsInMap: {} }, visited: visitedMaps() }));
    if (name.startsWith('milestone')) fs.writeFileSync(`${this.saveDir}/latest.txt`, name);
    this.ctx.log('save', `saved ${name}`);
  }

  load(name: string) {
    this.ctx.emu.loadState(`${this.saveDir}/${name}.state.json`);
    const memFile = `${this.saveDir}/${name}.memory.json`;
    if (fs.existsSync(memFile)) {
      const { mem, visited } = JSON.parse(fs.readFileSync(memFile, 'utf8'));
      Object.assign(this.ctx.mem, { triedNoProgress: {}, blockedExits: {}, bestHops: {} }, mem, { stepsInMap: {} });
      restoreVisited(visited);
    }
    this.lastMap = -1;
    this.ctx.log('save', `loaded ${name}`);
  }

  noteDecision(desc: string) {
    remember(this.ctx.mem.actions, desc, 12);
    this.decisionsSinceProgress++;
  }
}
