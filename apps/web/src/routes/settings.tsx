import { useQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { aiUsageQuery, shadowModeQuery, useUpdateShadowMode } from "@/api/queries.ts";
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
  CardHeader,
  CardTitle,
} from "@/components/ui/card.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Loader } from "@/components/ui/loader.tsx";
import { shadowModeProblem } from "@/lib/settings.ts";

export function SettingsPage() {
  return (
    <div className="flex flex-col gap-6">
      <h1 className="font-semibold text-2xl tracking-tight">Settings</h1>
      <ShadowModeSettings />
      <AiUsageSettings />
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
