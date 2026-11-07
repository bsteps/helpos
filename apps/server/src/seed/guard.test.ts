import { describe, expect, it } from "vitest";
import { checkSeedTarget } from "./guard.ts";

const local = "postgres://helpos_app:helpos_app@localhost:5432/helpos";

describe("checkSeedTarget", () => {
  it("allows local databases", () => {
    expect(checkSeedTarget({}, [local, "postgres://a:b@127.0.0.1:55432/helpos"])).toEqual({
      ok: true,
    });
    expect(checkSeedTarget({}, ["postgres://a:b@[::1]:5432/helpos"]).ok).toBe(true);
  });

  it.each([
    ["NODE_ENV", "production"],
    ["HELPOS_ENV", "Production"],
  ])("refuses when %s is %s, even on localhost", (name, value) => {
    const result = checkSeedTarget({ [name]: value }, [local]);
    expect(result).toEqual({ ok: false, reason: expect.stringContaining(name) });
  });

  it("refuses a remote database, even if only one of the URLs is remote", () => {
    const result = checkSeedTarget({}, [local, "postgres://a:b@db.prod.example.com:5432/helpos"]);
    expect(result).toEqual({ ok: false, reason: expect.stringContaining("db.prod.example.com") });
  });

  it("allows a remote host only when it is named in HELPOS_SEED_ALLOW_HOSTS", () => {
    const url = "postgres://a:b@postgres:5432/helpos";
    expect(checkSeedTarget({}, [url]).ok).toBe(false);
    expect(checkSeedTarget({ HELPOS_SEED_ALLOW_HOSTS: "other, postgres" }, [url]).ok).toBe(true);
    // Production still wins over an allowed host.
    expect(
      checkSeedTarget({ HELPOS_SEED_ALLOW_HOSTS: "postgres", NODE_ENV: "production" }, [url]).ok,
    ).toBe(false);
  });

  it("refuses hosts that only look local", () => {
    expect(checkSeedTarget({}, ["postgres://a:b@127.0.0.1.evil.example/helpos"]).ok).toBe(false);
    expect(checkSeedTarget({}, ["postgres://a:b@localhost/helpos?host=db.example.com"]).ok).toBe(
      false,
    );
  });

  it("refuses a URL it can't parse", () => {
    expect(checkSeedTarget({}, ["not a url"]).ok).toBe(false);
  });
});
