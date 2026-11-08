import { queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import { ApiError, api, type Draft, type Me, unwrap } from "./client.ts";

export const keys = {
  me: ["me"] as const,
  openTickets: ["tickets", "open"] as const,
  ticket: (id: string) => ["ticket", id] as const,
  drafts: (id: string) => ["ticket", id, "drafts"] as const,
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

export const openTicketsQuery = queryOptions({
  queryKey: keys.openTickets,
  queryFn: async () =>
    (await unwrap(api.GET("/v1/tickets", { params: { query: { status: "open", limit: 100 } } })))
      .tickets,
});

export const ticketQuery = (id: string) =>
  queryOptions({
    queryKey: keys.ticket(id),
    queryFn: () => unwrap(api.GET("/v1/tickets/{id}", { params: { path: { id } } })),
  });

/** No realtime yet: while a draft is being written or sent, look again every 2 seconds. */
export const draftsQuery = (id: string, waiting: (drafts: Draft[]) => boolean) =>
  queryOptions({
    queryKey: keys.drafts(id),
    queryFn: async () =>
      (await unwrap(api.GET("/v1/tickets/{id}/drafts", { params: { path: { id } } }))).drafts,
    refetchInterval: (query) => (waiting(query.state.data ?? []) ? 2_000 : false),
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

export function useEditDraft(ticketId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: string }) =>
      unwrap(api.PATCH("/v1/drafts/{id}", { params: { path: { id } }, body: { body } })),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: keys.drafts(ticketId) }),
  });
}

export function useApproveDraft(ticketId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    // The exact text the approver saw: if someone edited it since, the API refuses (409).
    mutationFn: ({ id, body }: { id: string; body: string }) =>
      unwrap(api.POST("/v1/drafts/{id}/approve", { params: { path: { id } }, body: { body } })),
    onSettled: () => queryClient.invalidateQueries({ queryKey: keys.drafts(ticketId) }),
  });
}

export function useCloseTicket(ticketId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      unwrap(api.POST("/v1/tickets/{id}/close", { params: { path: { id: ticketId } } })),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: keys.ticket(ticketId) }),
        queryClient.invalidateQueries({ queryKey: keys.openTickets }),
      ]);
    },
  });
}
