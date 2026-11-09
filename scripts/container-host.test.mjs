import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

// A container reached through `localhost` goes over IPv6 first, and Docker Desktop's IPv6
// forwarding stalls new connections under load, so tests time out at random.
test("tests reach containers through containerHost() from @helpos/db/testing, not getHost()", () => {
  const grep = spawnSync(
    "git",
    ["grep", "-n", "-F", ".getHost()", "--", "apps", "packages", ":!packages/db/src/testing.ts"],
    { encoding: "utf8" },
  );
  // git grep exits 1 when nothing matches.
  assert.equal(grep.status, 1, `use containerHost(container) instead:\n${grep.stdout}`);
});
