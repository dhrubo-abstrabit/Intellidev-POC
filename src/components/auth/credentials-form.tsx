"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { AuthActionResult } from "@/app/(auth)/actions";

interface CredentialsFormProps {
  action: (prev: AuthActionResult, formData: FormData) => Promise<AuthActionResult>;
  submitLabel: string;
  pendingLabel: string;
}

export function CredentialsForm({ action, submitLabel, pendingLabel }: CredentialsFormProps) {
  const [state, formAction, isPending] = useActionState<AuthActionResult, FormData>(action, {});

  return (
    <form action={formAction} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="email">Email</Label>
        <Input id="email" name="email" type="email" autoComplete="email" required />
      </div>
      <div className="space-y-2">
        <Label htmlFor="password">Password</Label>
        <Input id="password" name="password" type="password" autoComplete="current-password" required minLength={6} />
      </div>
      {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}
      <Button type="submit" className="w-full" disabled={isPending}>
        {isPending ? pendingLabel : submitLabel}
      </Button>
    </form>
  );
}
