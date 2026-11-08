import "./styles.css";
import { brand } from "@helpos/brand";
import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ApiError } from "./api/client.ts";
import { keys } from "./api/queries.ts";
import { createAppRouter } from "./router.tsx";

document.title = brand.name;

/** A session that ended mid-use (expired, signed out elsewhere) sends you back to sign in. */
function onApiError(error: unknown): void {
  if (!(error instanceof ApiError) || error.status !== 401) return;
  // On these pages a 401 is just a wrong password, shown in the form.
  if (["/login", "/set-password"].includes(router.state.location.pathname)) return;
  queryClient.setQueryData(keys.me, null);
  void router.navigate({ to: "/login", search: { redirect: router.state.location.href } });
}

const queryClient = new QueryClient({
  queryCache: new QueryCache({ onError: onApiError }),
  mutationCache: new MutationCache({ onError: onApiError }),
  defaultOptions: {
    // A 4xx won't get better by asking again.
    queries: { retry: (count, error) => !(error instanceof ApiError) && count < 2 },
  },
});
const router = createAppRouter(queryClient);

const root = document.getElementById("root");
if (!root) throw new Error("index.html has no #root");
createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
