import { experimental_evaluate as evaluate } from 'ai';
import type { JevBackend, JevRequest, JevResult } from './types.js';

/** Real Jev through Vercel AI Gateway (needs AI_GATEWAY_API_KEY or VERCEL_OIDC_TOKEN). */
export class GatewayJev implements JevBackend {
  name = 'gateway';
  constructor(private model = process.env.JEV_MODEL ?? 'typesafe-ai/jev') {}

  async evaluate(req: JevRequest): Promise<JevResult> {
    const res = await evaluate({
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
