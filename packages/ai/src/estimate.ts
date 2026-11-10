const utf8 = new TextEncoder();

/**
 * An upper bound on the tokens some text costs, to reserve from the daily budget before a
 * call: its size in UTF-8 bytes. The byte-level tokenizers the providers use never make more
 * tokens than bytes, whatever the language. It errs high (English runs about four bytes a
 * token), and the reservation is settled to the real figure after the call.
 */
export function tokenBound(...texts: string[]): number {
  return texts.reduce((sum, text) => sum + utf8.encode(text).length, 0);
}
