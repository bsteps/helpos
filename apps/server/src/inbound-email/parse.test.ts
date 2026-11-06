import { describe, expect, it } from "vitest";
import { noSubject, parseEmail } from "./parse.ts";

const enc = (lines: string[]) => new TextEncoder().encode(lines.join("\r\n"));

describe("parseEmail", () => {
  it("orders recipients Delivered-To, To, Cc, lowercased and deduplicated", async () => {
    const email = await parseEmail(
      enc([
        "From: a@x.test",
        "Delivered-To: Support@Acme.test",
        "To: Team: one@acme.test, SUPPORT@acme.test;",
        "Cc: two@acme.test",
        "",
        "hi",
      ]),
    );
    expect(email.recipients).toEqual(["support@acme.test", "one@acme.test", "two@acme.test"]);
  });

  it("threads on In-Reply-To first, then References newest-first", async () => {
    const email = await parseEmail(
      enc(["From: a@x.test", "In-Reply-To: <c@x>", "References: <a@x> <b@x>\r\n <c@x>", "", "hi"]),
    );
    expect(email.threadIds).toEqual(["<c@x>", "<b@x>", "<a@x>"]);
  });

  it("ignores junk in Message-ID headers", async () => {
    const email = await parseEmail(
      enc(["From: a@x.test", "Message-ID: not an id", "References: ; drop table <ok@x>", "", "hi"]),
    );
    expect(email.messageId).toBeNull();
    expect(email.references).toEqual(["<ok@x>"]);
  });

  it("strips NUL bytes, which Postgres text can't store", async () => {
    const email = await parseEmail(enc(["From: Ann\0 <a@x.test>", "Subject: a\0b", "", "c\0d"]));
    expect(email).toMatchObject({ subject: "ab", from: { name: "Ann" } });
    expect(email.text).toContain("cd");
  });

  it("fills in a subject and tolerates a missing From and Date", async () => {
    const email = await parseEmail(enc(["To: s@acme.test", "Date: not a date", "", "hi"]));
    expect(email).toMatchObject({ subject: noSubject, from: null, date: null });
  });
});
