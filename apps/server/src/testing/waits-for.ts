import { expect, it } from "vitest";

/**
 * A test for a promise an open issue has not built yet. It runs the real flow and pins today's
 * outcome exactly, so a broken setup fails it, and so does the guard landing, with the
 * instruction to turn it into a real test. `it.fails` would pass on any error at all.
 */
export function waitsFor<T>(
  issue: number,
  name: string,
  scenario: () => Promise<{ observed: T; today: T; promised: T }>,
): void {
  it(`${name} (waits for #${issue})`, async () => {
    const { observed, today, promised } = await scenario();
    expect(
      observed,
      `${name}: this changed. If #${issue} built the guard, turn this into it() asserting ${JSON.stringify(promised)}`,
    ).toEqual(today);
    expect(today, "today and promised must differ, or this test waits for nothing").not.toEqual(
      promised,
    );
  });
}
