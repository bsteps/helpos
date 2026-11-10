import { expect, test } from "@playwright/test";
import { deliver, plainEmail, signIn, state, uniqueSubject } from "./support.ts";

// The AI fails every try at drafting (the e2e model does so for these subjects, as if the
// provider were down). The worker gives up, and the ticket says so instead of showing
// "The AI is writing a draft…" forever. Asking the AI again from the ticket works.

type PausedTicket = { aiPausedReason: string | null };

test("a ticket the AI couldn't draft for says so, and the AI can be asked again", async ({
  page,
  request,
}) => {
  const subject = uniqueSubject(`Login ${state().modelDownMarker}`);
  const ticketId = await deliver(request, plainEmail(subject, "Hi, I can't log in."));
  await signIn(page);
  await expect
    .poll(
      async () =>
        ((await (await page.request.get(`/v1/tickets/${ticketId}`)).json()) as PausedTicket)
          .aiPausedReason,
      { timeout: 30_000 },
    )
    .toBe("draft_failed");

  await page.goto("/");
  const row = page.getByRole("listitem").filter({ has: page.getByRole("link", { name: subject }) });
  await expect(row.getByText("No AI draft")).toBeVisible();
  await row.getByRole("link", { name: subject }).click();
  // Only this alert: a draft can carry others (e.g. it used internal notes other tests added).
  const noDraft = page.getByRole("alert").filter({ hasText: "The AI couldn't write a draft" });
  await expect(noDraft).toBeVisible();
  await expect(page.getByText("The AI is writing a draft…")).toBeHidden();

  await page.getByRole("button", { name: "Ask the AI for a draft" }).click();
  await expect(page.getByTestId("draft-body")).toHaveText(state().draft, { timeout: 30_000 });
  await expect(noDraft).toBeHidden();
});
