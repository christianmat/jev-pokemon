import { experimental_evaluate as evaluate } from 'ai';
import type { JevBackend, JevRequest, JevResult } from './types.js';

/** Real Jev through Vercel AI Gateway (needs AI_GATEWAY_API_KEY or VERCEL_OIDC_TOKEN). */
export class GatewayJev implements JevBackend {
  name = 'gateway';
  constructor(private model = process.env.JEV_MODEL ?? 'typesafe-ai/jev') {}

  async evaluate(req: JevRequest): Promise<JevResult> {
    // a stuck request froze the game for a minute: time out and retry (normal latency is well under a second)
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.once(req);
      } catch (e) {
        if (attempt >= 4) throw e;
        console.error(`[jev] attempt ${attempt} failed (${(e as Error).message?.slice(0, 80)}), retrying`);
      }
    }
  }

  private async once(req: JevRequest): Promise<JevResult> {
    const res = await evaluate({
      abortSignal: AbortSignal.timeout(+(process.env.JEV_TIMEOUT_MS ?? 10_000)),
      model: this.model,
      // strict JSON only: drops undefined, turns Infinity/NaN into null
      state: JSON.parse(JSON.stringify(req.state)),
      questions: JSON.parse(JSON.stringify(req.questions)),
      providerOptions: { gateway: { zeroDataRetention: true } },
    });
    return {
      answers: res.answers as any,
      usage: { inputTokens: res.usage.inputTokens, outputTokens: res.usage.outputTokens },
      confidence: (res.providerMetadata as any)?.typesafe?.confidence,
    };
  }
}
