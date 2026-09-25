import './env.js';
import { RegionGraph } from '../game/regions.js';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { Emulator } from '../emu/emulator.js';
import { Rom } from '../game/rom.js';
import { GameState } from '../game/state.js';
import { Jev } from '../jev/client.js';
import { Agent } from '../agent/agent.js';
import { newMemory, type Ctx } from '../agent/context.js';
import { currentMilestone, MILESTONES } from '../knowledge/milestones.js';
import { Streamer, wrap } from '../stream/streamer.js';

const args = process.argv.slice(2);
const flag = (n: string) => args.includes(`--${n}`);
const opt = (n: string, d?: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };

const ROM_PATH = opt('rom', process.env.ROM_PATH ?? 'roms/red.gb')!;
const PORT = +(opt('port', process.env.PORT ?? '8787')!);
const HEADLESS = flag('headless');
const MAX_STEPS = +(opt('steps', '0')!);
const SPEED = +(opt('speed', process.env.SPEED ?? '0')!); // 0 = max, 1 = real time (60fps)

fs.mkdirSync('logs', { recursive: true });
const romBuf = fs.readFileSync(ROM_PATH);
const emu = new Emulator(romBuf);
const rom = new Rom(romBuf);
const gs = new GameState(emu, rom);
const jev = new Jev();
// lifetime totals across restarts (from the call log), for the stream panel
const PRICE_PER_M = +(process.env.JEV_PRICE_PER_M ?? 0.042);
let baseTokens = 0, baseCalls = 0;
try {
  for (const line of fs.readFileSync('logs/jev-calls.jsonl', 'utf8').split('\n')) {
    if (!line) continue;
    const r = JSON.parse(line);
    if (r.backend === 'gateway' && !r.cached) { baseTokens += r.inputTokens ?? 0; baseCalls++; }
  }
} catch { /* no log yet */ }
const events: unknown[] = [];
const sockets = new Set<WebSocket>();
const eventLog = fs.createWriteStream('logs/events.jsonl', { flags: 'a' });

function broadcast(obj: unknown) {
  const s = JSON.stringify(obj);
  for (const ws of sockets) if (ws.readyState === ws.OPEN) ws.send(s);
}

const ctx: Ctx = {
  emu, rom, gs, jev, regions: new RegionGraph(rom), mem: newMemory(),
  log(kind, msg, data) {
    const e = { t: Date.now(), frame: emu.frames, kind, msg, data };
    events.push(e); if (events.length > 300) events.shift();
    eventLog.write(JSON.stringify(e) + '\n');
    if (HEADLESS || kind !== 'decision') console.log(`[${kind}] ${msg}`);
    broadcast({ type: 'event', e });
  },
};

function updateOverlay(r?: { n: number; purpose: string; picked: Record<string, unknown>; answers: Record<string, any> }) {
  if (!streamer) return;
  const st = status();
  const W = streamer.cols;
  const tokens = baseTokens + (jev.backend.name === 'gateway' ? st.jev.inputTokens : 0);
  const calls = baseCalls + (jev.backend.name === 'gateway' ? st.jev.calls : 0);
  const cost = (tokens / 1e6) * PRICE_PER_M;
  const lines = ['# JEV PLAYS POKEMON RED', `~ ${st.badges} badges | goal ${st.milestone.index}/${st.milestone.total}`, `~ ${calls.toLocaleString('en-US')} jev calls | ${tokens.toLocaleString('en-US')} tokens`, `~ total cost: $${cost.toFixed(3)} USD`, ''];
  lines.push('# GOAL', ...wrap(st.milestone.goal ?? 'Game complete!', W).slice(0, 5), '');
  lines.push('# WHERE', st.map.replace(/_/g, ' '), '', '# TEAM');
  // "SPECIES (NICK)" when it has a nickname; stats right-aligned so the columns line up
  for (const p of st.party) {
    const nm = p.name && p.name !== p.species ? `${p.species} (${p.name})` : p.species;
    const stats = `Lv${String(p.level).padEnd(3)}${String(p.hp).padStart(3)}/${p.maxHp}`;
    lines.push(`${nm.slice(0, Math.max(10, W - stats.length - 1)).padEnd(Math.max(10, W - stats.length - 1))} ${stats}`);
  }
  if (r) {
    const a: any = Object.values(r.answers)[0];
    lines.push('', `# JEV DECISION (${r.purpose})`, ...wrap(`> ${String(Object.values(r.picked)[0])}`, W).slice(0, 2));
    if (a?.probabilities) {
      const top = Object.entries(a.probabilities as Record<string, number>).sort((x, y) => y[1] - x[1]).slice(0, 4);
      for (const [k, p] of top) lines.push(`~ ${String(Math.round(p * 100)).padStart(3)}% ${k.slice(0, W - 6)}`);
    }
  }
  streamer.setPanel(lines);
}

let lastCall: Parameters<typeof updateOverlay>[0] | null = null;
jev.onCall = (r) => { lastCall = r; updateOverlay(r); broadcast({
  type: 'jev', r: { n: r.n, purpose: r.purpose, latencyMs: r.latencyMs, cached: r.cached, picked: r.picked, answers: r.answers, backend: r.backend },
  stats: { calls: jev.calls, cacheHits: jev.cacheHits, inputTokens: jev.inputTokens },
}); };

const agent = new Agent(ctx);
const load = opt('load') ?? (flag('resume') && fs.existsSync('saves/latest.txt') ? fs.readFileSync('saves/latest.txt', 'utf8').trim() : undefined);
if (load) agent.load(load);

const sleepCell = new Int32Array(new SharedArrayBuffer(4));
const SLICES_PER_SEC = 4194304 / (emu.core.baseCPUCyclesPerIteration || 33554.432);

// optional headless live stream (STREAM_URL = rtmp://… or a local .mp4 for testing)
const streamer = process.env.STREAM_URL ? new Streamer(process.env.STREAM_URL, rom.b, (m) => ctx.log('stream', m)) : null;
if (streamer) { emu.onAudio = (l, r) => streamer.pushAudio(l, r); emu.enableAudioTap(); }
// keep the game (and its music) running while Jev thinks — idle frames, no button presses
if (SPEED > 0) jev.idle = () => emu.frame();

// frame streaming + pacing
let lastSent = 0, paceStart = Date.now(), paceFrames = 0;
emu.onFrame = (screen, frame) => {
  if (streamer && frame % 2 === 0) streamer.pushFrame(screen);
  if (SPEED > 0 && frame % 4 === 0) {
    // Fixed timeline (catches up after slow bot logic instead of drifting). serverboy's doFrame is one CPU
    // slice (~0.48 GB frames), so real time = 4194304 / cyclesPerSlice ≈ 125 slices/s.
    paceFrames += 4;
    const target = paceStart + (paceFrames * 1000) / (SLICES_PER_SEC * SPEED);
    const now = Date.now();
    if (target > now) Atomics.wait(sleepCell, 0, 0, target - now); // real sleep, no CPU burn
    else if (now - target > 250) { paceStart = now; paceFrames = 0; } // way behind (e.g. long Jev wait): resync
  }
  if (!sockets.size || HEADLESS) return;
  const now = Date.now();
  if (now - lastSent < 50) return;
  lastSent = now;
  const buf = Buffer.from(Uint8Array.from(screen as ArrayLike<number>));
  for (const ws of sockets) if (ws.readyState === ws.OPEN) ws.send(buf);
};

function status() {
  const { index, m } = currentMilestone(gs);
  return {
    type: 'status', map: gs.mapName, x: gs.x, y: gs.y, badges: gs.badgeCount, money: gs.money,
    milestone: { index, total: MILESTONES.length, id: m?.id, goal: m?.goal },
    party: gs.party().map((p) => ({ name: p.nickname, species: p.species, level: p.level, hp: p.hp, maxHp: p.maxHp, status: p.status })),
    jev: { backend: jev.backend.name, calls: jev.calls, cacheHits: jev.cacheHits, inputTokens: jev.inputTokens, minIntervalMs: jev.minIntervalMs, maxPerMinute: jev.maxPerMinute },
    frames: emu.frames,
  };
}

if (!HEADLESS) {
  const server = http.createServer((req, res) => {
    const file = req.url === '/' ? 'index.html' : req.url!.slice(1);
    const p = path.join('web', path.normalize(file));
    if (!p.startsWith('web') || !fs.existsSync(p)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': p.endsWith('.html') ? 'text/html' : 'text/plain' });
    fs.createReadStream(p).pipe(res);
  });
  const wss = new WebSocketServer({ server });
  wss.on('connection', (ws) => {
    sockets.add(ws);
    ws.send(JSON.stringify({ type: 'history', events }));
    ws.send(JSON.stringify(status()));
    ws.on('message', (d) => {
      const m = JSON.parse(String(d));
      if (m.cmd === 'pause') paused = !paused;
      if (m.cmd === 'save') agent.save(`manual-${Date.now()}`);
    });
    ws.on('close', () => sockets.delete(ws));
  });
  server.listen(PORT, () => console.log(`viewer: http://localhost:${PORT}  (jev backend: ${jev.backend.name})`));
}

let paused = false;
let steps = 0;
let lastAutosave = Date.now();
async function run() {
  ctx.log('info', `starting — jev=${jev.backend.name}, throttle ${jev.minIntervalMs}ms / ${jev.maxPerMinute} per min`);
  while (!agent.stopped && (!MAX_STEPS || steps < MAX_STEPS)) {
    if (paused) { await new Promise((r) => setTimeout(r, 200)); continue; }
    try {
      await agent.step();
    } catch (e) {
      ctx.log('error', String((e as Error).stack ?? e));
      emu.wait(30);
    }
    steps++;
    if (steps % 10 === 0) { broadcast(status()); if (streamer) updateOverlay(lastCall ?? undefined); }
    if (Date.now() - lastAutosave > 5 * 60_000) { agent.save('autosave'); lastAutosave = Date.now(); }
    if (currentMilestone(gs).m === null) { ctx.log('milestone', '🏆 HALL OF FAME — game complete'); agent.save('hall-of-fame'); break; }
    await new Promise((r) => setImmediate(r));
  }
  const st = status();
  console.log(JSON.stringify({ steps, ...st }, null, 0));
  if (HEADLESS) { agent.save('headless-end'); process.exit(0); }
}
run();
