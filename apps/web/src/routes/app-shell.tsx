import { brand } from "@helpos/brand";
import { Link, Outlet, useNavigate, useRouteContext } from "@tanstack/react-router";
import { LogOut } from "lucide-react";
import { useSignOut } from "@/api/queries.ts";
import { Button } from "@/components/ui/button.tsx";

/** The frame around every signed-in page: product name, workspace, sign out. */
export function AppShell() {
  const { me } = useRouteContext({ from: "/signed-in" });
  const signOut = useSignOut();
  const navigate = useNavigate();

  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-20 border-border border-b bg-background/90 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-3xl items-center justify-between gap-3 px-4">
          <div className="flex min-w-0 items-baseline gap-2">
            <Link to="/" className="font-semibold text-foreground tracking-tight">
              {brand.name}
            </Link>
            <span className="truncate text-muted-foreground text-sm">{me.workspace.name}</span>
          </div>
          <nav aria-label="Account" className="flex shrink-0 items-center gap-1 whitespace-nowrap">
            {me.scopes.includes("workspace:admin") ? (
              <Link
                to="/settings"
                className="rounded-full px-2 py-1.5 text-muted-foreground text-sm hover:text-foreground data-[status=active]:text-foreground sm:px-3"
              >
                Settings
              </Link>
            ) : null}
            <Button
              variant="ghost"
              size="sm"
              disabled={signOut.isPending}
              onClick={() =>
                signOut.mutate(undefined, { onSuccess: () => void navigate({ to: "/login" }) })
              }
            >
              <LogOut aria-hidden className="size-3.5" />
              <span className="sr-only sm:not-sr-only">Sign out</span>
            </Button>
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-3xl px-4 py-6">
        <Outlet />
      </main>
    </div>
  );
}
