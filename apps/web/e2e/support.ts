import { readFileSync } from "node:fs";
import { type APIRequestContext, expect, type Page } from "@playwright/test";

/** Written by the e2e server (apps/server/src/e2e/serve.ts) once it is ready. */
export interface E2eState {
  baseUrl: string;
  mailpitUrl: string;
  inboundSecret: string;
  owner: string;
  mailbox: string;
  passwordSetupLink: string;
  draft: string;
  /** An internal note, and the phrase that makes the mock AI paste it into a draft. */
  internalNote: string;
  pasteTrigger: string;
  /** The one repo the fake GitHub knows, and the one token it accepts. */
  githubRepo: string;
  githubToken: string;
  /** The title the AI suggests for every GitHub issue. */
  issueTitle: string;
  /** A reply whose subject has this in it fails to send until it is retried from the dashboard. */
  smtpDownMarker: string;
  /** An email whose subject has this in it gets no AI draft until the AI is asked again. */
  modelDownMarker: string;
  /** Like `modelDownMarker`, but asking the AI again fails too: only the next ask works. */
  modelStillDownMarker: string;
  seedOwner: string;
  seedMember: string;
  seedPassword: string;
  /** The owner of a workspace whose daily AI budget is one draft, its mailbox and password. */
  budgetOwner: string;
  budgetMailbox: string;
  budgetPassword: string;
  /** The owner of a workspace whose shadow recipient a test changes, its mailbox and password. */
  shadowOwner: string;
  shadowMailbox: string;
  shadowPassword: string;
}

export function state(): E2eState {
  return JSON.parse(
    readFileSync(new URL("../.e2e/state.json", import.meta.url), "utf8"),
  ) as E2eState;
}

/** The password the setup project gives the owner. */
export const ownerPassword = "correct horse battery staple";

/** A subject no other test (or other screen size) uses, so tests never see each other's mail. */
export function uniqueSubject(label: string): string {
  return `${label} ${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** Delivers a raw email the way a provider would: through the public inbound endpoint. */
export async function deliver(request: APIRequestContext, raw: string): Promise<string> {
  const { baseUrl, inboundSecret } = state();
  const res = await request.post(`${baseUrl}/v1/inbound/email`, {
    headers: { authorization: `Bearer ${inboundSecret}`, "content-type": "message/rfc822" },
    data: Buffer.from(raw.replace(/\r?\n/g, "\r\n")),
  });
  expect(res.status(), await res.text()).toBe(201);
  const body = (await res.json()) as { ticketId: string };
  return body.ticketId;
}

export function plainEmail(subject: string, text: string, to: string = state().mailbox): string {
  return [
    "From: Jane Customer <jane@customer.test>",
    `To: ${to}`,
    `Subject: ${subject}`,
    `Message-ID: <${crypto.randomUUID()}@customer.test>`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    text,
  ].join("\n");
}

export async function signIn(
  page: Page,
  credentials: { email: string; password: string } = {
    email: state().owner,
    password: ownerPassword,
  },
): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Email").fill(credentials.email);
  await page.getByLabel("Password").fill(credentials.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Inbox" })).toBeVisible();
}

interface MailpitMessage {
  ID: string;
  Subject: string;
  To: { Address: string }[];
}

/** Waits until Mailpit has caught an email with exactly this subject, and returns it. */
export async function waitForMail(
  request: APIRequestContext,
  subject: string,
): Promise<{ to: string[]; text: string }> {
  const { mailpitUrl } = state();
  let found: MailpitMessage | undefined;
  await expect
    .poll(
      async () => {
        const res = await request.get(`${mailpitUrl}/api/v1/messages`);
        const { messages } = (await res.json()) as { messages: MailpitMessage[] };
        found = messages.find((m) => m.Subject === subject);
        return found !== undefined;
      },
      { timeout: 30_000, message: `email "${subject}" in Mailpit` },
    )
    .toBe(true);
  if (!found) throw new Error("unreachable");
  const detail = (await (await request.get(`${mailpitUrl}/api/v1/message/${found.ID}`)).json()) as {
    Text: string;
  };
  return { to: found.To.map((t) => t.Address), text: detail.Text };
}
