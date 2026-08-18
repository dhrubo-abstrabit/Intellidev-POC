"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { requestPasswordReset, type ForgotPasswordResult } from "@/app/(auth)/actions";

export function ForgotPasswordForm() {
  const [state, formAction, isPending] = useActionState<ForgotPasswordResult, FormData>(requestPasswordReset, {});

  if (state.success) {
    return (
      <p className="text-sm text-brand-n-700">
        If an account exists for that email, we&apos;ve sent a link to reset your password.
      </p>
    );
  }

  return (
    <form action={formAction} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="email" className="text-brand-n-700">
          Email address
        </Label>
        <Input id="email" name="email" type="email" autoComplete="email" required />
      </div>
      {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}
      <Button type="submit" className="w-full rounded-full" disabled={isPending}>
        {isPending ? "Sending..." : "Send reset link"}
      </Button>
    </form>
  );
}
