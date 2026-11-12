import { brand } from "@helpos/brand";
import { useNavigate } from "@tanstack/react-router";
import { type FormEvent, useEffect, useState } from "react";
import { useSetPassword } from "@/api/queries.ts";
import { Alert, AlertContent, AlertDescription, AlertIcon } from "@/components/ui/alert.tsx";
import { Button } from "@/components/ui/button.tsx";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card.tsx";
import { Input } from "@/components/ui/input.tsx";
import { setPasswordProblem } from "@/lib/auth.ts";

const minLength = 12;

/** The token arrives in the URL fragment, which never reaches a server. */
function tokenFromUrl(): string | null {
  return new URLSearchParams(window.location.hash.slice(1)).get("token");
}

export function SetPasswordPage() {
  const navigate = useNavigate();
  const setPassword = useSetPassword();
  const [token] = useState(tokenFromUrl);
  // Once read, drop it from the address bar, so it doesn't stay in history or get shared.
  useEffect(() => {
    if (window.location.hash) window.history.replaceState(null, "", window.location.pathname);
  }, []);
  const [password, setPasswordValue] = useState("");
  const [confirm, setConfirm] = useState("");
  const [touched, setTouched] = useState(false);

  const tooShort = password.length < minLength;
  const mismatch = confirm !== password;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (!token || tooShort || mismatch) return;
    setPassword.mutate(
      { token, password },
      { onSuccess: () => void navigate({ to: "/login", search: { passwordSet: true } }) },
    );
  };

  return (
    <main className="flex min-h-dvh items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>
            <h1 className="text-xl">Set your {brand.name} password</h1>
          </CardTitle>
          <CardDescription>
            At least {minLength} characters. A long phrase works well.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {token ? (
            <form onSubmit={submit} className="flex flex-col gap-4">
              <Input
                label="New password"
                type="password"
                name="new-password"
                autoComplete="new-password"
                required
                value={password}
                onChange={setPasswordValue}
                error={touched && tooShort ? `Use at least ${minLength} characters.` : false}
              />
              <Input
                label="Repeat it"
                type="password"
                name="confirm-password"
                autoComplete="new-password"
                required
                value={confirm}
                onChange={setConfirm}
                error={touched && !tooShort && mismatch ? "The two don't match." : false}
              />
              {setPassword.isError ? (
                <Alert variant="destructive">
                  <AlertIcon />
                  <AlertContent>
                    <AlertDescription>{setPasswordProblem(setPassword.error)}</AlertDescription>
                  </AlertContent>
                </Alert>
              ) : null}
              <Button type="submit" disabled={setPassword.isPending} className="w-full">
                Set password
              </Button>
            </form>
          ) : (
            <Alert variant="warning">
              <AlertIcon />
              <AlertContent>
                <AlertDescription>
                  This page needs the full link you were sent. Open that link again.
                </AlertDescription>
              </AlertContent>
            </Alert>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
