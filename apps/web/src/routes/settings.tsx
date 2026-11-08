import { useQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { ApiError, type GithubConnected } from "@/api/client.ts";
import {
  githubQuery,
  useConnectGithub,
  useDisconnectGithub,
  useRotateGithubWebhookSecret,
} from "@/api/queries.ts";
import {
  Alert,
  AlertContent,
  AlertDescription,
  AlertIcon,
  AlertTitle,
} from "@/components/ui/alert.tsx";
import { AnimatedBadge } from "@/components/ui/animated-badge.tsx";
import { Button } from "@/components/ui/button.tsx";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Loader } from "@/components/ui/loader.tsx";

export function SettingsPage() {
  return (
    <div className="flex flex-col gap-6">
      <h1 className="font-semibold text-2xl tracking-tight">Settings</h1>
      <GithubSettings />
    </div>
  );
}

function connectProblem(error: unknown): string {
  if (!(error instanceof ApiError)) return "That didn't work. Try again.";
  switch (error.code) {
    case "token_rejected":
      return "GitHub didn't accept this token. Check it hasn't expired and has Issues read and write access to the repo.";
    case "repo_not_found":
      return "GitHub says this repo doesn't exist, or the token can't see it.";
    case "github_unavailable":
      return "Couldn't reach GitHub. Try again.";
    case "encryption_not_configured":
      return "This server can't store tokens yet: whoever runs it needs to set HELPOS_ENCRYPTION_KEY.";
    default:
      // The token's shape is checked before sending, so a 400 here is about the repo name.
      return error.status === 400
        ? "Enter the repo as owner/name, e.g. acme/app."
        : "That didn't work. Try again.";
  }
}

function GithubSettings() {
  const { me } = useRouteContext({ from: "/signed-in" });
  const isAdmin = me.scopes.includes("workspace:admin");
  // An admin sees the connection too, so they never connect over one they can't see.
  const github = useQuery({
    ...githubQuery,
    enabled: isAdmin || me.scopes.includes("github:write"),
  });
  const connect = useConnectGithub();
  const disconnect = useDisconnectGithub();
  const rotate = useRotateGithubWebhookSecret();
  const [repo, setRepo] = useState("");
  const [token, setToken] = useState("");
  // The secret is shown once, from the connect or rotate response. It lives only in this
  // state until the page is left: the mutations' own copies are cleared as soon as it's here,
  // and it is never cached, stored or sent anywhere.
  const [connected, setConnected] = useState<ShownSecret | null>(null);

  // Checked here, so the form names the field that's wrong. The API refuses it too.
  const classicToken = token.trim() !== "" && !token.trim().startsWith("github_pat_");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (classicToken) return;
    connect.mutate(
      { repo: repo.trim(), token: token.trim() },
      {
        onSuccess: (result) => {
          setConnected(result);
          setToken("");
          connect.reset();
        },
      },
    );
  };

  const status = github.data;
  return (
    <Card>
      <CardHeader>
        <CardTitle as="h2">GitHub</CardTitle>
        <CardDescription>
          Turn tickets into GitHub issues. When an issue is closed as done, a fix notice for the
          customer is drafted for you to approve.
        </CardDescription>
        <CardAction>
          {status ? (
            <AnimatedBadge status={status.connected ? "success" : "neutral"} size="sm">
              {status.connected ? "Connected" : "Not connected"}
            </AnimatedBadge>
          ) : null}
        </CardAction>
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        {github.isPending && (isAdmin || me.scopes.includes("github:write")) ? (
          <Loader size={16} label="Loading" />
        ) : null}
        {status?.connected ? (
          <p>
            Issues are created in <span className="font-medium">{status.repo}</span>.
          </p>
        ) : null}

        {connected ? <WebhookSetup connected={connected} /> : null}
        {disconnect.isError || rotate.isError ? (
          <Alert variant="destructive">
            <AlertIcon />
            <AlertContent>
              <AlertDescription>
                {disconnect.isError
                  ? "Couldn't disconnect. Nothing changed; try again."
                  : "Couldn't make a new webhook secret. The old one still works; try again."}
              </AlertDescription>
            </AlertContent>
          </Alert>
        ) : null}

        {isAdmin ? (
          <form onSubmit={submit} className="flex flex-col gap-4">
            <p className="text-muted-foreground text-sm">
              {status?.connected ? "Connect a different repo or token" : "Connect a repo"} with a
              fine-grained personal access token that has <strong>Issues: read and write</strong> on
              that one repo. It is stored encrypted and never shown again.
            </p>
            <Input
              label="Repository"
              placeholder="owner/name"
              value={repo}
              onChange={setRepo}
              autoComplete="off"
              required
              disabled={connect.isPending}
            />
            <Input
              label="Personal access token"
              type="password"
              placeholder="github_pat_…"
              value={token}
              onChange={setToken}
              error={
                classicToken
                  ? "Use a fine-grained token (it starts with github_pat_). A classic token reaches every repo you can, so it isn't accepted."
                  : false
              }
              autoComplete="off"
              required
              disabled={connect.isPending}
            />
            {connect.isError ? (
              <Alert variant="destructive">
                <AlertIcon />
                <AlertContent>
                  <AlertDescription>{connectProblem(connect.error)}</AlertDescription>
                </AlertContent>
              </Alert>
            ) : null}
            <div className="flex flex-wrap justify-end gap-2">
              <Button type="submit" disabled={connect.isPending || !repo.trim() || !token.trim()}>
                {connect.isPending ? (
                  <Loader size={16} label="Connecting" className="text-current" />
                ) : null}
                Connect
              </Button>
            </div>
          </form>
        ) : (
          <p className="text-muted-foreground text-sm">Only workspace owners can change this.</p>
        )}
      </CardContent>

      {isAdmin && status?.connected ? (
        <CardFooter className="justify-end gap-2">
          <Button
            variant="ghost"
            disabled={rotate.isPending || disconnect.isPending}
            onClick={() => {
              disconnect.reset();
              rotate.mutate(undefined, {
                onSuccess: ({ webhookSecret }) => {
                  setConnected({
                    connected: true,
                    repo: status.repo,
                    webhookUrl: status.webhookUrl,
                    webhookSecret,
                    rotated: true,
                  });
                  rotate.reset();
                },
              });
            }}
          >
            New webhook secret
          </Button>
          <Button
            variant="ghost"
            disabled={rotate.isPending || disconnect.isPending}
            onClick={() => {
              rotate.reset();
              disconnect.mutate(undefined, { onSuccess: () => setConnected(null) });
            }}
          >
            Disconnect
          </Button>
        </CardFooter>
      ) : null}
    </Card>
  );
}

/** What the webhook needs, shown once: after connecting, or after asking for a new secret. */
type ShownSecret = GithubConnected & { rotated?: boolean };

function WebhookSetup({ connected }: { connected: ShownSecret }) {
  if (connected.webhookSecret === null) {
    return (
      <Alert variant="success">
        <AlertIcon />
        <AlertContent>
          <AlertTitle>Connected to {connected.repo}</AlertTitle>
          <AlertDescription>
            The webhook secret didn't change, so the webhook already set up in GitHub keeps working.
            For a new one, use New webhook secret below.
          </AlertDescription>
        </AlertContent>
      </Alert>
    );
  }
  return (
    <Alert variant="success">
      <AlertIcon />
      <AlertContent>
        <AlertTitle>
          {connected.rotated
            ? "New webhook secret. Paste it into GitHub now"
            : `Connected to ${connected.repo}. One more step in GitHub`}
        </AlertTitle>
        <AlertDescription>
          {connected.rotated ? (
            <p>
              In the repo's Settings → Webhooks, edit the webhook and replace its secret: until then
              GitHub's deliveries are refused. The secret is shown only now.
            </p>
          ) : (
            <p>
              In the repo's Settings → Webhooks, add a webhook with these values, and pick only the{" "}
              <strong>Issues</strong> event. The secret is shown only now.
            </p>
          )}
          <dl className="mt-2 grid gap-1 text-sm">
            <dt className="font-medium">Payload URL</dt>
            <dd>
              <code data-testid="webhook-url" className="break-all">
                {connected.webhookUrl}
              </code>
            </dd>
            <dt className="font-medium">Content type</dt>
            <dd>
              <code>application/json</code>
            </dd>
            <dt className="font-medium">Secret</dt>
            <dd>
              <code data-testid="webhook-secret" className="break-all">
                {connected.webhookSecret}
              </code>
            </dd>
          </dl>
        </AlertDescription>
      </AlertContent>
    </Alert>
  );
}
