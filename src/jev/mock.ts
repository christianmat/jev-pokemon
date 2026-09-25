import type { JevBackend, JevRequest, JevResult, JevAnswer } from './types.js';

/**
 * Development stand-in for Jev. Same request/response shape, zero cost.
 * It has NO game knowledge: it scores choice options by generic sentiment
 * words in the option descriptions the harness provides, plus noise.
 * The real Jev replaces this 1:1 via JEV_MODE=gateway.
 */
const POS: [RegExp, number][] = [
  [/toward (the )?objective|objective is here|completes objective/i, 3],
  [/super effective/i, 2.5],
  [/unvisited|never been|not yet talked|unexplored/i, 1],
  [/heals|restore/i, 0.5],
  [/likely KO|high damage/i, 1.5],
  [/advances|confirm|continue/i, 0.5],
];
const NEG: [RegExp, number][] = [
  [/no effect|immune/i, -5],
  [/not very effective/i, -1.5],
  [/away from (the )?objective|backtrack/i, -1.5],
  [/0 PP|fainted|unusable/i, -6],
  [/already visited|talked already|recently/i, -0.8],
  [/risky|dangerous|low HP/i, -0.7],
  [/cancel|go back/i, -0.5],
];

const text = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v ?? ''));

export class MockJev implements JevBackend {
  name = 'mock';
  constructor(private temperature = 0.6, private latencyMs = 0) {}

  async evaluate(req: JevRequest): Promise<JevResult> {
    if (this.latencyMs) await new Promise((r) => setTimeout(r, this.latencyMs));
    const answers: Record<string, JevAnswer> = {};
    let tokens = Math.ceil(text(req.state).length / 4);
    for (const [id, q] of Object.entries(req.questions)) {
      tokens += Math.ceil((text(q.instructions).length + text(q.criteria).length) / 4);
      if (q.type === 'choice') {
        const keys = Object.keys(q.criteria);
        const logits = keys.map((k) => {
          const d = `${k} ${text(q.criteria[k])}`;
          let s = Math.random() * 0.6;
          for (const [re, w] of [...POS, ...NEG]) if (re.test(d)) s += w;
          return s / this.temperature;
        });
        const mx = Math.max(...logits);
        const ex = logits.map((l) => Math.exp(l - mx));
        const sum = ex.reduce((a, b) => a + b, 0);
        const probabilities = Object.fromEntries(keys.map((k, i) => [k, ex[i] / sum]));
        const choice = keys[ex.indexOf(Math.max(...ex))];
        answers[id] = { type: 'choice', choice, probabilities };
      } else if (q.type === 'boolean') {
        answers[id] = { type: 'boolean', probability: 0.5 + (Math.random() - 0.5) * 0.2 };
      } else {
        const n = q.criteria.length;
        answers[id] = { type: 'score', score: (n - 1) / 2 };
      }
    }
    return { answers, usage: { inputTokens: tokens, outputTokens: 0 } };
  }
}
