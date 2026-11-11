import { expect, test } from "@playwright/test";
import { deliver, plainEmail, signIn, state, uniqueSubject, waitForMail } from "./support.ts";

for (const action of ["Mark sent", "Send again"]) {
  test(`uncertain send requires the owner to choose ${action}`, async ({ page, request }) => {
    const subject = uniqueSubject("smtp-reply-lost");
    await deliver(request, plainEmail(subject, "Where is my refund?"));
    await signIn(page);
    await page.getByRole("link", { name: subject }).click();
    await expect(page.getByTestId("draft-body")).toHaveText(state().draft);
    await page.getByRole("button", { name: "Approve & send" }).click();
    await expect(page.getByText("Delivery uncertain", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Retry send", exact: true })).toBeHidden();
    const first = await waitForMail(request, `Re: ${subject}`);
    expect(first.to).toEqual([state().owner]);
    await page.getByRole("button", { name: action, exact: true }).click();
    await expect(page.getByText("Sent", { exact: true })).toBeVisible();
    const response = await request.get(`${state().mailpitUrl}/api/v1/messages`);
    const body = await response.json();
    expect(
      body.messages.filter((m: { Subject: string }) => m.Subject === `Re: ${subject}`),
    ).toHaveLength(action === "Send again" ? 2 : 1);
    await page.screenshot({
      path: `test-results/uncertain-${action.replaceAll(" ", "-")}.png`,
      fullPage: true,
    });
  });
}
