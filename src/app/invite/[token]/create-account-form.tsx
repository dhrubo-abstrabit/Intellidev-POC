"use client";

import { useActionState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { acceptWithNewAccount } from "./actions";

const INITIAL: { error?: string } = {};

/**
 * Set a password and accept, in one step.
 *
 * The email is deliberately shown but not editable — it comes from the
 * invitation server-side, and letting it be typed would mean a caller could
 * mint a confirmed account for any address they liked.
 */
export function CreateAccountForm({ token, email }: { token: string; email: string }) {
  const [state, formAction, pending] = useActionState(acceptWithNewAccount.bind(null, token), INITIAL);

  return (
    <form action={formAction} className="space-y-3">
      <div className="grid gap-1.5">
        <Label htmlFor="invite-account-email">Email</Label>
        <Input id="invite-account-email" value={email} disabled readOnly />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="invite-account-name">Your name</Label>
        <Input
          id="invite-account-name"
          name="fullName"
          type="text"
          required
          maxLength={120}
          autoComplete="name"
          placeholder="Priya Nair"
        />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="invite-account-password">Choose a password</Label>
        <Input
          id="invite-account-password"
          name="password"
          type="password"
          required
          minLength={6}
          autoComplete="new-password"
          placeholder="At least 6 characters"
        />
      </div>
      <Button type="submit" disabled={pending} className="w-full">
        {pending ? "Creating your account…" : "Accept and create account"}
      </Button>
      {state?.error ? (
        <p className="text-sm text-destructive">
          {state.error}{" "}
          {/already exists/i.test(state.error) ? (
            <Link href={`/login?next=/invite/${token}`} className="underline underline-offset-4">
              Sign in
            </Link>
          ) : null}
        </p>
      ) : null}
      <p className="text-center text-xs text-muted-foreground">
        Already have an account?{" "}
        <Link href={`/login?next=/invite/${token}`} className="underline underline-offset-4">
          Sign in instead
        </Link>
      </p>
    </form>
  );
}
