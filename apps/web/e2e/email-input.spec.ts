import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { deliver, signIn, state, uniqueSubject } from "./support.ts";

for (const { fixture, text, formatted } of [
  {
    fixture: "multipart-mismatch",
    text: "Plain-part request: please refund $900.",
    formatted: "HTML-part request: I only need a receipt.",
  },
  {
    fixture: "html-textarea",
    text: "I only need a receipt.\nPlease refund $900.",
    formatted: "I only need a receipt.",
  },
]) {
  test(`the approver can read the AI's message text for ${fixture}`, async ({ page, request }) => {
    const subject = uniqueSubject(fixture);
    const raw = readFileSync(
      new URL(`../../../fixtures/email/${fixture}.eml`, import.meta.url),
      "utf8",
    )
      .replace(/^Subject: .*$/m, `Subject: ${subject}`)
      .replace(/^Message-ID: .*$/m, `Message-ID: <${crypto.randomUUID()}@customer.test>`);
    const id = await deliver(request, raw);
    await signIn(page);
    await page.getByRole("link", { name: subject }).click();
    const response = await page.request.get(`${state().baseUrl}/v1/conversations/${id}`);
    expect(response.status()).toBe(200);
    expect(await response.json()).toMatchObject({ messages: [{ text }] });
    await expect(page.getByTestId("message-text")).toHaveText(text);
    await expect(page.getByTestId("message-text")).toBeVisible();
    await expect(page.getByRole("button", { name: "Approve & send" })).toBeVisible();
    await page.getByText("Formatted email", { exact: true }).click();
    const email = page.frameLocator('iframe[title="Email from jane@customer.test"]');
    await expect(email.getByText(formatted, { exact: true })).toBeVisible();
    await expect(email.getByText("Please refund $900.", { exact: true })).toHaveCount(0);
    await expect(page.getByTestId("message-text")).toBeVisible();
  });
}
