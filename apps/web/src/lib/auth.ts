import { ApiError } from "../api/client.ts";

export function signInProblem(error: unknown): string {
  if (error instanceof ApiError && error.status === 401) return "Wrong email or password.";
  if (error instanceof ApiError && error.status === 503) {
    return "Sign-in isn't set up on this server yet. Ask whoever runs it.";
  }
  return "Couldn't sign in. Try again.";
}

export function setPasswordProblem(error: unknown): string {
  if (error instanceof ApiError && error.status === 400) {
    return "This link has expired or was already used. Ask for a new one.";
  }
  return "Couldn't set the password. Try again.";
}
