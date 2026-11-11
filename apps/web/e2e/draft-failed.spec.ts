import { expect, test } from "@playwright/test";
import { deliver, plainEmail, signIn, state, uniqueSubject } from "./support.ts";

// The AI fails every try at drafting (the e2e model does so for these subjects, as if the
// provider were down). The worker gives up, and the conversation says so instead of showing
// "The AI is writing a draft…" forever. Asking the AI again from the conversation works.

type PausedConversation = { aiPausedReason: string | null };

test("a conversation the AI couldn't draft for says so, and the AI can be asked again", async ({
  page,
  request,
}) => {
  const subject = uniqueSubject(`Login ${state().modelDownMarker}`);
  const conversationId = await deliver(request, plainEmail(subject, "Hi, I can't log in."));
  await signIn(page);
  await expect
    .poll(
      async () =>
        (
          (await (
            await page.request.get(`/v1/conversations/${conversationId}`)
          ).json()) as PausedConversation
        ).aiPausedReason,
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

test("when the AI fails again after being asked again, the conversation says so again, not a spinner", async ({
  page,
  request,
}) => {
  const subject = uniqueSubject(`Billing ${state().modelStillDownMarker}`);
  const conversationId = await deliver(request, plainEmail(subject, "Hi, I was charged twice."));
  await signIn(page);
  const reason = async () =>
    (
      (await (
        await page.request.get(`/v1/conversations/${conversationId}`)
      ).json()) as PausedConversation
    ).aiPausedReason;
  await expect.poll(reason, { timeout: 30_000 }).toBe("draft_failed");

  await page.goto(`/conversations/${conversationId}`);
  const noDraft = page.getByRole("alert").filter({ hasText: "The AI couldn't write a draft" });
  await expect(noDraft).toBeVisible();

  // The second ask fails every try too. The page waits while it runs, then says so again.
  await page.getByRole("button", { name: "Ask the AI for a draft" }).click();
  await expect(page.getByText("The AI is writing a draft…")).toBeVisible();
  await expect(noDraft).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("The AI is writing a draft…")).toBeHidden();

  // The inbox says the same, and the next ask works.
  await page.goto("/");
  const row = page.getByRole("listitem").filter({ has: page.getByRole("link", { name: subject }) });
  await expect(row.getByText("No AI draft")).toBeVisible();
  await row.getByRole("link", { name: subject }).click();
  await page.getByRole("button", { name: "Ask the AI for a draft" }).click();
  await expect(page.getByTestId("draft-body")).toHaveText(state().draft, { timeout: 30_000 });
});
