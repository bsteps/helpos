import { describe, expect, it } from "vitest";
import { detectAutomated, type Header } from "./automated.ts";

const h = (key: string, value: string): Header => ({ key, value });

describe("detectAutomated", () => {
  it.each([
    ["Auto-Submitted: auto-replied", [h("auto-submitted", "auto-replied")], "auto_submitted"],
    ["Auto-Submitted: auto-generated", [h("auto-submitted", "Auto-Generated")], "auto_submitted"],
    ["Precedence: bulk", [h("precedence", "bulk")], "precedence"],
    ["Precedence: junk", [h("precedence", "junk")], "precedence"],
    ["Precedence: list", [h("precedence", "list")], "precedence"],
    ["List-Id", [h("list-id", "<news.vendor.test>")], "mailing_list"],
    ["List-Unsubscribe", [h("list-unsubscribe", "<mailto:u@v.test>")], "mailing_list"],
    ["X-Auto-Response-Suppress", [h("x-auto-response-suppress", "OOF")], "auto_response_suppress"],
    [
      "a DSN",
      [h("content-type", "multipart/report; report-type=delivery-status")],
      "delivery_report",
    ],
  ])("flags %s", (_, headers, reason) => {
    expect(detectAutomated(headers, "jane@customer.test")).toBe(reason);
  });

  it.each(["MAILER-DAEMON@mx.test", "postmaster@mx.test"])("flags mail from %s", (from) => {
    expect(detectAutomated([], from.toLowerCase())).toBe("system_sender");
  });

  it("lets ordinary mail through, including Auto-Submitted: no", () => {
    const headers = [
      h("auto-submitted", "no"),
      h("precedence", "normal"),
      h("content-type", "text/plain"),
    ];
    expect(detectAutomated(headers, "jane@customer.test")).toBeNull();
    expect(detectAutomated([], null)).toBeNull();
  });

  it("does not mistake a person called postmaster-jane for a system sender", () => {
    expect(detectAutomated([], "postmaster-jane@customer.test")).toBeNull();
  });
});
