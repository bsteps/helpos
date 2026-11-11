import type { QueryClient } from "@tanstack/react-query";
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  Outlet,
  redirect,
} from "@tanstack/react-router";
import { meQuery } from "./api/queries.ts";
import { safeRedirect } from "./lib/redirect.ts";
import { AppShell } from "./routes/app-shell.tsx";
import { ConversationPage } from "./routes/conversation.tsx";
import { InboxPage } from "./routes/inbox.tsx";
import { KnowledgePage } from "./routes/knowledge.tsx";
import { LoginPage } from "./routes/login.tsx";
import { SetPasswordPage } from "./routes/set-password.tsx";
import { SettingsPage } from "./routes/settings.tsx";

const rootRoute = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  component: Outlet,
});

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  validateSearch: (search: Record<string, unknown>): { redirect?: string; passwordSet?: true } => {
    const to = safeRedirect(search.redirect);
    return {
      ...(to ? { redirect: to } : {}),
      ...(search.passwordSet === true ? { passwordSet: true } : {}),
    };
  },
  component: LoginPage,
});

const setPasswordRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/set-password",
  component: SetPasswordPage,
});

/** Everything behind sign-in. */
const signedInRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "signed-in",
  beforeLoad: async ({ context, location }) => {
    const me = await context.queryClient.ensureQueryData(meQuery);
    if (!me) throw redirect({ to: "/login", search: { redirect: location.href } });
    return { me };
  },
  component: AppShell,
});

const inboxRoute = createRoute({
  getParentRoute: () => signedInRoute,
  path: "/",
  component: InboxPage,
});

export const conversationRoute = createRoute({
  getParentRoute: () => signedInRoute,
  path: "/conversations/$id",
  component: ConversationPage,
});

const settingsRoute = createRoute({
  getParentRoute: () => signedInRoute,
  path: "/settings",
  component: SettingsPage,
});

const knowledgeRoute = createRoute({
  getParentRoute: () => signedInRoute,
  path: "/knowledge",
  beforeLoad: ({ context }) => {
    if (!context.me.scopes.includes("knowledge:read")) throw redirect({ to: "/" });
  },
  component: KnowledgePage,
});

const routeTree = rootRoute.addChildren([
  loginRoute,
  setPasswordRoute,
  signedInRoute.addChildren([inboxRoute, conversationRoute, knowledgeRoute, settingsRoute]),
]);

export function createAppRouter(queryClient: QueryClient) {
  return createRouter({ routeTree, context: { queryClient }, defaultPreload: "intent" });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
