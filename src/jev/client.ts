import fs from 'node:fs';
import crypto from 'node:crypto';
import type { JevBackend, JevQuestion, JevInput, JevResult, JevAnswer } from './types.js';
import { MockJev } from './mock.js';
import { GatewayJev } from './gateway.js';

export interface JevCallRecord {
  n: number; at: number; purpose: string; latencyMs: number; cached: boolean;
  backend: string; state: JevInput; questions: Record<string, JevQuestion>; answers: Record<string, JevAnswer>;
  picked: Record<string, string | number>; inputTokens: number;
}

/**
 * Throttled, cached, logged Jev client.
 * - minIntervalMs: never call more often than this
 * - maxPerMinute: hard rolling budget (waits when exceeded)
 * - identical (state, questions) within the cache are answered from cache
 */
export class Jev {
  readonly backend: JevBackend;
  calls = 0;
  cacheHits = 0;
  inputTokens = 0;
  private last = 0;
  private window: number[] = [];
  private cache = new Map<string, JevResult>();
  private log: fs.WriteStream;
  onCall?: (r: JevCallRecord) => void;
  /** Called repeatedly while waiting on the network (keeps the game/audio running idle). */
  idle?: () => void;
  /** When true, sample from the distribution instead of argmax (used to escape loops). */
  explore = false;

  constructor(opts: { mode?: string; minIntervalMs?: number; maxPerMinute?: number; logFile?: string } = {}) {
    const mode = opts.mode ?? process.env.JEV_MODE ?? 'mock';
    this.backend = mode === 'gateway' ? new GatewayJev() : new MockJev(0.6, +(process.env.JEV_MOCK_LATENCY_MS ?? 0));
    this.minIntervalMs = opts.minIntervalMs ?? +(process.env.JEV_MIN_INTERVAL_MS ?? 300);
    this.maxPerMinute = opts.maxPerMinute ?? +(process.env.JEV_MAX_PER_MIN ?? 90);
    this.log = fs.createWriteStream(opts.logFile ?? 'logs/jev-calls.jsonl', { flags: 'a' });
  }
  minIntervalMs: number;
  maxPerMinute: number;

  private async throttle() {
    for (;;) {
      const now = Date.now();
      this.window = this.window.filter((t) => now - t < 60_000);
      const waitInterval = this.last + this.minIntervalMs - now;
      const waitBudget = this.window.length >= this.maxPerMinute ? this.window[0] + 60_000 - now : 0;
      const w = Math.max(waitInterval, waitBudget);
      if (w <= 0) break;
      await this.withIdle(new Promise((r) => setTimeout(r, w)));
    }
    this.last = Date.now();
    this.window.push(this.last);
  }

  /** Await a promise while ticking the idle hook (one emulator frame per turn of the event loop). */
  private async withIdle<T>(p: Promise<T>): Promise<T> {
    if (!this.idle) return p;
    let done = false;
    p.then(() => { done = true; }, () => { done = true; });
    while (!done) {
      this.idle();
      await new Promise((r) => setImmediate(r));
    }
    return p;
  }

  async ask(purpose: string, state: JevInput, questions: Record<string, JevQuestion>) {
    const key = crypto.createHash('sha1').update(JSON.stringify([state, questions])).digest('hex');
    const t0 = Date.now();
    let res = this.explore ? undefined : this.cache.get(key);
    const cached = !!res;
    if (!res) {
      await this.throttle();
      for (let attempt = 0; ; attempt++) {
        try { res = await this.withIdle(this.backend.evaluate({ state, questions })); break; }
        catch (e) {
          if (attempt >= 4) throw e;
          await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
        }
      }
      this.calls++;
      this.inputTokens += res.usage.inputTokens ?? 0;
      this.cache.set(key, res);
      if (this.cache.size > 500) this.cache.delete(this.cache.keys().next().value!);
    } else this.cacheHits++;

    const picked: Record<string, string | number> = {};
    for (const [id, a] of Object.entries(res.answers)) {
      if (a.type === 'choice') picked[id] = this.explore && a.probabilities ? sample(flatten(a.probabilities)) : a.choice;
      else if (a.type === 'boolean') picked[id] = a.probability;
      else picked[id] = a.score;
    }
    const rec: JevCallRecord = {
      n: this.calls, at: Date.now(), purpose, latencyMs: Date.now() - t0, cached, backend: this.backend.name,
      state, questions, answers: res.answers, picked, inputTokens: res.usage.inputTokens ?? 0,
    };
    this.log.write(JSON.stringify(rec) + '\n');
    this.onCall?.(rec);
    return { picked, answers: res.answers };
  }

  /** Convenience: a single choice question. Returns the chosen option key. */
  async choose(purpose: string, state: JevInput, instructions: string, options: Record<string, string>): Promise<string> {
    const keys = Object.keys(options);
    if (keys.length === 1) return keys[0];
    const { picked } = await this.ask(purpose, state, { decision: { type: 'choice', instructions, criteria: options } });
    return picked.decision as string;
  }
}

/** Exploration: mix Jev's distribution 50/50 with uniform so a 100% answer can't lock a loop. */
function flatten(p: Record<string, number>): Record<string, number> {
  const n = Object.keys(p).length;
  return Object.fromEntries(Object.entries(p).map(([k, v]) => [k, 0.5 * v + 0.5 / n]));
}

function sample(p: Record<string, number>): string {
  let r = Math.random();
  for (const [k, v] of Object.entries(p)) { r -= v; if (r <= 0) return k; }
  return Object.keys(p)[0];
}
