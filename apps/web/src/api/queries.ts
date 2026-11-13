import { type QueryClient, queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import { ApiError, api, type Draft, type Me, unwrap } from "./client.ts";

export const keys = {
  me: ["me"] as const,
  openConversations: ["conversations", "open"] as const,
  conversation: (id: string) => ["conversation", id] as const,
  drafts: (id: string) => ["conversation", id, "drafts"] as const,
  github: ["integrations", "github"] as const,
  draftStats: ["stats", "drafts"] as const,
  shadowMode: ["workspace", "shadow-mode"] as const,
};

/** Who is signed in, or null when nobody is (the API answered 401). */
export const meQuery = queryOptions({
  queryKey: keys.me,
  queryFn: async (): Promise<Me | null> => {
    try {
      return await unwrap(api.GET("/v1/me"));
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) return null;
      throw error;
    }
  },
  staleTime: 60_000,
});

export const openConversationsQuery = queryOptions({
  queryKey: keys.openConversations,
  queryFn: async () =>
    (
      await unwrap(
        // Closed conversations too, while their reply couldn't be sent: the customer still waits.
        api.GET("/v1/conversations", {
          params: { query: { status: "open", orReplyNotSent: "true", limit: 100 } },
        }),
      )
    ).conversations,
});

export const conversationQuery = (id: string) =>
  queryOptions({
    queryKey: keys.conversation(id),
    queryFn: () => unwrap(api.GET("/v1/conversations/{id}", { params: { path: { id } } })),
  });

/** No realtime yet: while a draft is being written or sent, look again every 2 seconds. */
export const draftsQuery = (id: string, waiting: (drafts: Draft[]) => boolean) =>
  queryOptions({
    queryKey: keys.drafts(id),
    queryFn: async () =>
      (await unwrap(api.GET("/v1/conversations/{id}/drafts", { params: { path: { id } } }))).drafts,
    refetchInterval: (query) => (waiting(query.state.data ?? []) ? 2_000 : false),
  });

/** Draft outcomes for the last `days` days, ending now on this device's clock. */
export const draftStatsQuery = (days: number) =>
  queryOptions({
    queryKey: [...keys.draftStats, days],
    queryFn: () => {
      const to = new Date();
      const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);
      return unwrap(
        api.GET("/v1/stats/drafts", {
          params: { query: { from: from.toISOString(), to: to.toISOString() } },
        }),
      );
    },
    staleTime: 60_000,
  });

export function useSignIn() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: { email: string; password: string }) =>
      unwrap(api.POST("/v1/auth/sign-in", { body })),
    // Drop the cached "nobody", so the next page asks the server who this is now.
    onSuccess: () => queryClient.removeQueries({ queryKey: keys.me }),
  });
}

export function useSignOut() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => unwrap(api.POST("/v1/auth/sign-out")),
    // Nothing of the old session may linger in the cache for the next person.
    onSuccess: () => queryClient.clear(),
  });
}

export function useSetPassword() {
  return useMutation({
    mutationFn: (body: { token: string; password: string }) =>
      unwrap(api.POST("/v1/auth/password", { body })),
  });
}

export function useEditDraft(conversationId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: string }) =>
      unwrap(api.PATCH("/v1/drafts/{id}", { params: { path: { id } }, body: { body } })),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: keys.drafts(conversationId) }),
  });
}

export function useApproveDraft(conversationId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    // The exact text the approver saw: if someone edited it since, the API refuses (409).
    mutationFn: ({ id, body }: { id: string; body: string }) =>
      unwrap(api.POST("/v1/drafts/{id}/approve", { params: { path: { id } }, body: { body } })),
    onSettled: () => queryClient.invalidateQueries({ queryKey: keys.drafts(conversationId) }),
  });
}

/** Queues a draft whose send failed for good to be sent again. Safe to repeat. */
export function useRetryDraft(conversationId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      unwrap(api.POST("/v1/drafts/{id}/retry", { params: { path: { id } } })),
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: keys.drafts(conversationId) }),
        // The inbox flags conversations whose reply couldn't be sent.
        queryClient.invalidateQueries({ queryKey: keys.openConversations }),
      ]),
  });
}

export function useDiscardDraft(conversationId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      unwrap(api.POST("/v1/drafts/{id}/discard", { params: { path: { id } } })),
    onSettled: () =>
      Promise.all([
        invalidateDraftState(queryClient, conversationId),
        // The inbox flags conversations whose reply couldn't be sent.
        queryClient.invalidateQueries({ queryKey: keys.openConversations }),
      ]),
  });
}

/** Saves a person's draft, or asks the AI for a fresh one (it shows up in the drafts list once written). */
export function useCreateDraft(conversationId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { regenerate: true } | { body: string }): Promise<void> => {
      await unwrap(
        api.POST("/v1/conversations/{id}/drafts", {
          params: { path: { id: conversationId } },
          body: input,
        }),
      );
    },
    onSettled: () => invalidateDraftState(queryClient, conversationId),
  });
}

/**
 * A new draft can lift the conversation's "AI paused" state, and asking the AI again clears a failed
 * one, so the conversation is fetched again too, and the inbox that shows the state.
 */
function invalidateDraftState(queryClient: QueryClient, conversationId: string) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: keys.drafts(conversationId) }),
    queryClient.invalidateQueries({ queryKey: keys.conversation(conversationId) }),
    queryClient.invalidateQueries({ queryKey: keys.openConversations }),
  ]);
}

export function useCloseConversation(conversationId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/v1/conversations/{id}/close", { params: { path: { id: conversationId } } }),
      ),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: keys.conversation(conversationId) }),
        queryClient.invalidateQueries({ queryKey: keys.openConversations }),
      ]);
    },
  });
}

/** The workspace's GitHub connection: which repo, never the token. */
export const githubQuery = queryOptions({
  queryKey: keys.github,
  queryFn: () => unwrap(api.GET("/v1/integrations/github")),
  staleTime: 60_000,
});

export function useConnectGithub() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: { repo: string; token: string }) =>
      unwrap(api.PUT("/v1/integrations/github", { body })),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: keys.github }),
  });
}

export function useDisconnectGithub() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => unwrap(api.DELETE("/v1/integrations/github")),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: keys.github }),
  });
}

/** A new webhook secret, e.g. after a leak. The token stays; the old secret stops working. */
export function useRotateGithubWebhookSecret() {
  return useMutation({
    mutationFn: () => unwrap(api.POST("/v1/integrations/github/webhook-secret")),
  });
}

/** Asks the AI for a title and body. Nothing is created until the issue is confirmed. */
export function useDraftGithubIssue(conversationId: string) {
  return useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/v1/conversations/{id}/github-issue/draft", {
          params: { path: { id: conversationId } },
        }),
      ),
  });
}

export function useCreateGithubIssue(conversationId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: { title: string; body: string }) =>
      unwrap(
        api.POST("/v1/conversations/{id}/github-issue", {
          params: { path: { id: conversationId } },
          body,
        }),
      ),
    // Refetched either way: a 409 means the conversation already has an issue to show. The returned
    // promise is awaited before a caller's own onSuccess runs, so the composer closes only
    // once the conversation shows its issue, never flashing the "Create GitHub issue" button back.
    onSettled: () => queryClient.invalidateQueries({ queryKey: keys.conversation(conversationId) }),
  });
}

export const shadowModeQuery = queryOptions({
  queryKey: keys.shadowMode,
  queryFn: () => unwrap(api.GET("/v1/workspace/shadow-mode")),
});

export function useUpdateShadowMode() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: { enabled?: boolean; recipient?: string }) =>
      unwrap(api.PATCH("/v1/workspace/shadow-mode", { body })),
    onSuccess: (data) => queryClient.setQueryData(keys.shadowMode, data),
  });
}

export function useResolveSend(conversationId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      messageId,
      decision,
    }: {
      id: string;
      messageId: string;
      decision: "mark_sent" | "send_again";
    }) =>
      unwrap(
        api.POST("/v1/drafts/{id}/resolve-send", {
          params: { path: { id } },
          body: { messageId, decision },
        }),
      ),
    onSettled: () =>
      Promise.all([
        invalidateDraftState(queryClient, conversationId),
        queryClient.invalidateQueries({ queryKey: keys.openConversations }),
      ]),
  });
}
