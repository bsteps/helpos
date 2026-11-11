import type { EmbeddingModel, LanguageModel } from "ai";

const paid = Symbol("paid model");

export interface PaidModel<M> {
  readonly [paid]: () => { model: M; abortSignal: AbortSignal; maxRetries: 0 };
}

export type PaidModels = <M extends LanguageModel | EmbeddingModel>(model: M) => PaidModel<M>;

export async function withPaidModels<T>(
  signal: AbortSignal,
  call: (models: PaidModels) => Promise<T>,
): Promise<T> {
  let active = true;
  const models: PaidModels = (model) => ({
    [paid]: () => {
      if (!active) throw new Error("The paid AI call has ended");
      signal.throwIfAborted();
      return { model, abortSignal: signal, maxRetries: 0 };
    },
  });
  try {
    return await call(models);
  } finally {
    active = false;
  }
}

export function paidModelOptions<M>(model: PaidModel<M>) {
  return model[paid]();
}
