import { mergeConfig } from "vitest/config";
import base from "../../vitest.config.mts";

export default mergeConfig(base, {
  test: { setupFiles: ["./src/testing/setup.ts"] },
});
