import { vi } from "vitest";
import { contractApp } from "./contract.ts";

vi.mock("../app.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("../app.ts")>();
  return {
    ...original,
    createApp: (...args: Parameters<typeof original.createApp>) =>
      contractApp(original.createApp(...args)),
  };
});
