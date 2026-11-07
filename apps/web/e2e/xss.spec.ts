import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { deliver, signIn, uniqueSubject } from "./support.ts";

// ADR 0004: customer HTML is rendered sanitised, in a sandboxed iframe, under a strict CSP.
// The fixture tries scripts, event handlers, javascript: links, frames, forms, remote images
// and CSS that phones home. In a real browser, none of it may run or reach evil.test.

const fixture = readFileSync(new URL("../../../fixtures/email/xss.eml", import.meta.url), "utf8");

test("a malicious HTML email is shown as harmless text", async ({ page, request }) => {
  const subject = uniqueSubject("Please look at my invoice");
  const raw = fixture
    .replace(/^Subject: .*$/m, `Subject: ${subject}`)
    .replace(/^Message-ID: .*$/m, `Message-ID: <${crypto.randomUUID()}@customer.test>`);
  await deliver(request, raw);

  // Anything that tries to reach the sender's server is recorded, and a dialog fails the test.
  const leaks: string[] = [];
  page.on("request", (req) => {
    if (req.url().includes("evil.test")) leaks.push(req.url());
  });
  page.on("dialog", (dialog) => {
    leaks.push(`dialog: ${dialog.message()}`);
    void dialog.dismiss();
  });

  await signIn(page);
  const response = await page.goto("/");
  const csp = response?.headers()["content-security-policy"] ?? "";
  expect(csp).toContain("script-src 'self'");
  expect(csp).toContain("img-src 'self' data:");
  expect(csp).toContain("frame-ancestors 'none'");

  await page.getByRole("link", { name: subject }).click();
  const frameElement = page.locator('iframe[title="Email from mallory@customer.test"]');
  await expect(frameElement).toHaveAttribute(
    "sandbox",
    "allow-same-origin allow-popups allow-popups-to-escape-sandbox",
  );

  // The readable part is there…
  const email = page.frameLocator('iframe[title="Email from mallory@customer.test"]');
  await expect(email.getByText("XSS-SAFE-MARKER")).toBeVisible();
  await expect(email.getByText("[image: tracking pixel]")).toBeVisible();
  await expect(email.getByRole("link", { name: "a normal link" })).toHaveAttribute(
    "rel",
    "noopener noreferrer nofollow",
  );

  // …and nothing else is.
  const frame = await (await frameElement.elementHandle())?.contentFrame();
  if (!frame) throw new Error("email frame not found");
  const dangerous = await frame.evaluate(
    () =>
      document.querySelectorAll(
        "script, iframe, object, embed, form, input, svg, math, base, meta[http-equiv=refresh], link, style, img:not([src^='data:'])",
      ).length,
  );
  expect(dangerous).toBe(0);
  const handlers = await frame.evaluate(() =>
    [...document.querySelectorAll("*")].flatMap((el) =>
      [...el.attributes].map((a) => a.name).filter((n) => n.startsWith("on")),
    ),
  );
  expect(handlers).toEqual([]);

  // Clicking what used to be a javascript: link does nothing.
  await email.getByText("click me").click();

  // Give anything delayed (a meta refresh, a lazy image) a moment to try.
  await page.waitForTimeout(1_000);
  expect(await page.evaluate(() => Reflect.get(window, "__xss"))).toBeUndefined();
  expect(leaks).toEqual([]);
  await expect(page.getByRole("heading", { name: subject })).toBeVisible();
});
