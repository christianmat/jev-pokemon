// Mirrors AI SDK `experimental_evaluate` (model 'typesafe-ai/jev') request/response shapes.

export type JevInput = string | Record<string, unknown> | unknown[];

export type JevQuestion =
  | { type: 'choice'; instructions: JevInput; criteria: Record<string, JevInput | null> }
  | { type: 'score'; instructions: JevInput; criteria: (JevInput | null)[] }
  | { type: 'boolean'; instructions: JevInput; criteria?: { true?: JevInput | null; false?: JevInput | null } };

export type JevAnswer =
  | { type: 'choice'; choice: string; probabilities?: Record<string, number> }
  | { type: 'score'; score: number; probabilities?: Record<string, number> }
  | { type: 'boolean'; probability: number };

export interface JevRequest {
  state: JevInput;
  questions: Record<string, JevQuestion>;
}

export interface JevResult {
  answers: Record<string, JevAnswer>;
  usage: { inputTokens?: number; outputTokens?: number };
  confidence?: number;
}

export interface JevBackend {
  name: string;
  evaluate(req: JevRequest): Promise<JevResult>;
}
