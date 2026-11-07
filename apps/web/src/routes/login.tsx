import { brand } from "@helpos/brand";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { ApiError } from "@/api/client.ts";
import { useSignIn } from "@/api/queries.ts";
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
import { Loader } from "@/components/ui/loader.tsx";

function message(error: unknown): string {
  if (error instanceof ApiError && error.status === 401) return "Wrong email or password.";
  if (error instanceof ApiError && error.status === 503) {
    return "Sign-in isn't set up on this server yet. Ask whoever runs it.";
  }
  return "Couldn't sign in. Try again.";
}

export function LoginPage() {
  const search = useSearch({ from: "/login" });
  const navigate = useNavigate();
  const signIn = useSignIn();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const submit = (event: FormEvent) => {
    event.preventDefault();
    signIn.mutate(
      { email, password },
      { onSuccess: () => void navigate({ to: search.redirect ?? "/" }) },
    );
  };

  return (
    <main className="flex min-h-dvh items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>
            <h1 className="text-xl">Sign in to {brand.name}</h1>
          </CardTitle>
          <CardDescription>Use the email and password of your workspace account.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="flex flex-col gap-4">
            {search.passwordSet ? (
              <Alert variant="success">
                <AlertIcon />
                <AlertContent>
                  <AlertDescription>Your password is set. Sign in with it.</AlertDescription>
                </AlertContent>
              </Alert>
            ) : null}
            <Input
              label="Email"
              type="email"
              name="email"
              autoComplete="username"
              required
              value={email}
              onChange={setEmail}
            />
            <Input
              label="Password"
              type="password"
              name="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={setPassword}
            />
            {signIn.isError ? (
              <Alert variant="destructive">
                <AlertIcon />
                <AlertContent>
                  <AlertDescription>{message(signIn.error)}</AlertDescription>
                </AlertContent>
              </Alert>
            ) : null}
            <Button type="submit" disabled={signIn.isPending} className="w-full">
              {signIn.isPending ? (
                <Loader size={16} label="Signing in" className="text-current" />
              ) : null}
              Sign in
            </Button>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
