import { useQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import type { GithubConnected } from "@/api/client.ts";
import {
  aiUsageQuery,
  githubQuery,
  shadowModeQuery,
  useConnectGithub,
  useDisconnectGithub,
  useRotateGithubWebhookSecret,
  useUpdateShadowMode,
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
import { connectProblem, shadowModeProblem } from "@/lib/settings.ts";

export function SettingsPage() {
  return (
    <div className="flex flex-col gap-6">
      <h1 className="font-semibold text-2xl tracking-tight">Settings</h1>
      <ShadowModeSettings />
      <AiUsageSettings />
      <GithubSettings />
    </div>
  );
}

function ShadowModeSettings() {
  const { me } = useRouteContext({ from: "/signed-in" });
  const isAdmin = me.scopes.includes("workspace:admin");
  const shadow = useQuery(shadowModeQuery);
  const update = useUpdateShadowMode();
  const [typedRecipient, setTypedRecipient] = useState<string | null>(null);
  const [confirmingOff, setConfirmingOff] = useState(false);
  const status = shadow.data;
  const recipientInput = typedRecipient ?? status?.recipient ?? "";

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setConfirmingOff(false);
    update.mutate(
      { recipient: recipientInput.trim() },
      { onSuccess: () => setTypedRecipient(null) },
    );
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle as="h2">Shadow mode</CardTitle>
        <CardDescription>
          While it's on, every approved reply goes to the shadow recipient instead of the customer,
          so you can check the AI's work safely.
        </CardDescription>
        <CardAction>
          {status ? (
            <AnimatedBadge status={status.enabled ? "warning" : "neutral"} size="sm">
              {status.enabled ? "On" : "Off"}
            </AnimatedBadge>
          ) : null}
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {shadow.isPending ? <Loader size={16} label="Loading" /> : null}
        {shadow.isError ? (
          <p className="text-muted-foreground text-sm">
            Couldn't load shadow mode. Reload to try again.
          </p>
        ) : null}
        {status ? (
          <p data-testid="shadow-mode-summary">
            {!status.enabled ? (
              "Replies go to customers."
            ) : status.recipient ? (
              <>
                Replies go to <span className="font-medium">{status.recipient}</span>, not to
                customers.
              </>
            ) : (
              "Approved replies wait until a shadow recipient is set."
            )}
          </p>
        ) : null}
        {update.isError ? (
          <Alert variant="destructive">
            <AlertIcon />
            <AlertContent>
              <AlertDescription>{shadowModeProblem(update.error)}</AlertDescription>
            </AlertContent>
          </Alert>
        ) : null}
        {status?.enabled && confirmingOff ? (
          <Alert variant="warning">
            <AlertIcon />
            <AlertContent>
              <AlertTitle>Turn off shadow mode?</AlertTitle>
              <AlertDescription>
                Approved replies will go to customers instead of the shadow recipient.
              </AlertDescription>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button
                  variant="primary"
                  size="sm"
                  disabled={update.isPending}
                  onClick={() =>
                    update.mutate({ enabled: false }, { onSettled: () => setConfirmingOff(false) })
                  }
                >
                  Send replies to customers
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={update.isPending}
                  onClick={() => setConfirmingOff(false)}
                >
                  Keep shadow mode on
                </Button>
              </div>
            </AlertContent>
          </Alert>
        ) : null}
        {status && isAdmin ? (
          <form onSubmit={submit} className="flex flex-col gap-4">
            <Input
              label="Shadow recipient"
              type="email"
              value={recipientInput}
              onChange={setTypedRecipient}
              autoComplete="email"
              required
              disabled={update.isPending}
            />
            <div className="flex flex-wrap justify-end gap-2">
              <Button
                type="button"
                variant="ghost"
                disabled={update.isPending}
                onClick={() => {
                  if (!status.enabled) return update.mutate({ enabled: true });
                  update.reset();
                  setConfirmingOff(true);
                }}
              >
                {status.enabled ? "Turn off shadow mode" : "Turn on shadow mode"}
              </Button>
              <Button
                type="submit"
                disabled={
                  update.isPending ||
                  !recipientInput.trim() ||
                  recipientInput.trim() === (status.recipient ?? "")
                }
              >
                Save recipient
              </Button>
            </div>
          </form>
        ) : status ? (
          <p className="text-muted-foreground text-sm">Only workspace owners can change this.</p>
        ) : null}
      </CardContent>
    </Card>
  );
}

const count = new Intl.NumberFormat();

function AiUsageSettings() {
  const usage = useQuery(aiUsageQuery);
  const data = usage.data;
  return (
    <Card>
      <CardHeader>
        <CardTitle as="h2">AI usage today</CardTitle>
        <CardDescription>
          Tokens AI drafting used today, against the workspace's daily budget. It resets at midnight
          UTC.
        </CardDescription>
        <CardAction>
          {data ? (
            <AnimatedBadge status={data.paused ? "danger" : "success"} size="sm">
              {data.paused ? "Paused" : "Drafting"}
            </AnimatedBadge>
          ) : null}
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {usage.isPending ? <Loader size={16} label="Loading" /> : null}
        {usage.isError ? (
          <p className="text-muted-foreground text-sm">
            Couldn't load AI usage. Reload to try again.
          </p>
        ) : null}
        {data ? (
          <dl className="grid grid-cols-3 gap-2 text-sm">
            <div>
              <dt className="text-muted-foreground">Used</dt>
              <dd data-testid="ai-usage-used" className="font-medium text-lg tabular-nums">
                {count.format(data.totalTokens)}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Budget</dt>
              <dd data-testid="ai-usage-budget" className="font-medium text-lg tabular-nums">
                {count.format(data.dailyTokenBudget)}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Left</dt>
              <dd data-testid="ai-usage-remaining" className="font-medium text-lg tabular-nums">
                {count.format(data.remainingTokens)}
              </dd>
            </div>
          </dl>
        ) : null}
        {data?.paused ? (
          <Alert variant="warning">
            <AlertIcon />
            <AlertContent>
              <AlertTitle>Drafting is paused</AlertTitle>
              <AlertDescription>
                Today's budget is used up, so new conversations get no AI draft until midnight UTC.
              </AlertDescription>
            </AlertContent>
          </Alert>
        ) : null}
      </CardContent>
    </Card>
  );
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
          Turn conversations into GitHub issues. When an issue is closed as done, a fix notice for
          the customer is drafted for you to approve.
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
