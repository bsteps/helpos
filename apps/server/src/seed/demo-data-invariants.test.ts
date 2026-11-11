import type { schema } from "@helpos/db";
import { describe, expect, it } from "vitest";
import { draftTransitions } from "../drafts/lifecycle.ts";
import { buildDemoData } from "./demo-data.ts";

const cases = buildDemoData().tenants.flatMap((tenant) =>
  tenant.drafts.map((draft) => ({ workspace: tenant.key, tenant, draft })),
);

describe("demo draft lifecycle invariants", () => {
  it.each(cases)(
    "$workspace draft $draft.id has the fields its status requires",
    ({ tenant, draft }) => {
      expect(draft.tenantId).toBe(tenant.tenant.id);
      expect(draft.body.trim()).not.toBe("");
      const conversation = tenant.conversations.find((row) => row.id === draft.conversationId);
      const inbound = tenant.messages.find((row) => row.id === draft.messageId);
      expect(conversation).toBeDefined();
      expect(inbound).toMatchObject({
        tenantId: draft.tenantId,
        conversationId: draft.conversationId,
        direction: "inbound",
        automatedReason: null,
      });
      expect(draft.createdAt).toBeInstanceOf(Date);
      expect(inbound?.createdAt.getTime()).toBeLessThanOrEqual(draft.createdAt?.getTime() ?? 0);

      switch (draft.status) {
        case "pending":
        case "discarded":
          expect(draft.approvedAt).toBeNull();
          expect(draft.outboundMessageIdHeader).toBeNull();
          expect(draft.sentAt).toBeNull();
          expect(draft.sentMessageId).toBeNull();
          break;
        case "sent": {
          expect(draft.approvedAt).toBeInstanceOf(Date);
          expect(draft.sentAt).toBeInstanceOf(Date);
          expect(draft.sentMessageId).toEqual(expect.any(String));
          expect(draft.outboundMessageIdHeader).toMatch(/^<[^<>\s]+@[^<>\s]+>$/);
          expect(draft.approvedAt?.getTime()).toBeGreaterThanOrEqual(
            draft.createdAt?.getTime() ?? 0,
          );
          expect(draft.sentAt?.getTime()).toBeGreaterThanOrEqual(draft.approvedAt?.getTime() ?? 0);
          const outbound = tenant.messages.find((row) => row.id === draft.sentMessageId);
          expect(outbound).toMatchObject({
            tenantId: draft.tenantId,
            conversationId: draft.conversationId,
            direction: "outbound",
            textBody: draft.body,
            messageIdHeader: draft.outboundMessageIdHeader,
            inReplyTo: inbound?.messageIdHeader,
            sentAt: draft.sentAt,
          });
          break;
        }
        default:
          throw new Error(`demo draft status needs invariant coverage: ${draft.status}`);
      }
      expect(draft.resendRequested ?? false).toBe(false);
    },
  );

  it.each(cases)(
    "$workspace draft $draft.id has a legal, complete audit history",
    ({ tenant, draft }) => {
      const history = tenant.audit.filter((event) => event.targetId === draft.id);
      expect(history[0]).toMatchObject({
        action: "draft.created",
        createdAt: draft.createdAt,
      });
      expect(history.filter((event) => event.action === "draft.created")).toHaveLength(1);
      let status: schema.DraftStatus = "pending";
      let previousTime = draft.createdAt?.getTime() ?? 0;
      for (const [index, event] of history.entries()) {
        expect(event).toMatchObject({
          tenantId: tenant.tenant.id,
          targetType: "draft",
          requestId: null,
        });
        expect(event.createdAt).toBeInstanceOf(Date);
        expect(event.createdAt?.getTime()).toBeGreaterThanOrEqual(previousTime);
        previousTime = event.createdAt?.getTime() ?? 0;
        if (event.actorType === "agent") {
          const token = tenant.tokens.find((row) => row.id === event.actorId);
          expect(token?.scopes).toContain("drafts:write");
          expect(token?.createdAt.getTime()).toBeLessThanOrEqual(previousTime);
          expect(
            token?.revokedAt === null || (token?.revokedAt?.getTime() ?? 0) > previousTime,
          ).toBe(true);
        } else {
          expect(event).toMatchObject({ actorType: "system", actorId: "seed" });
        }
        if (index === 0) continue;
        const transitions = Object.values(draftTransitions).filter(
          (transition) =>
            transition.audit === event.action && transition.from.some((from) => from === status),
        );
        expect(transitions.length, `${event.action} cannot follow ${status}`).toBeGreaterThan(0);
        expect(new Set(transitions.map((transition) => transition.to)).size).toBe(1);
        status = transitions[0]?.to ?? status;
        if (event.action === "draft.approved") expect(event.createdAt).toEqual(draft.approvedAt);
        if (event.action === "draft.sent") expect(event.createdAt).toEqual(draft.sentAt);
      }
      expect(status).toBe(draft.status);
      expect(draft.updatedAt?.getTime()).toBe(previousTime);
    },
  );
});
