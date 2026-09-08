"use client";

import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { AuthActionResult } from "@/app/(auth)/actions";

interface CredentialsFormProps {
  action: (prev: AuthActionResult, formData: FormData) => Promise<AuthActionResult>;
  /** Same-site path to land on after auth. Submitted as a hidden field so the
   * Server Action reads it from FormData rather than from a header it cannot
   * see. Validated server-side regardless — see safeNext(). */
  next?: string;
  submitLabel: string;
  pendingLabel: string;
  /** Sign-up only. Without a name we have nothing to put in users.full_name,
   * and every roster in the app renders the person as "—" forever, because
   * nothing else ever asks. */
  collectName?: boolean;
}

export function CredentialsForm({ action, submitLabel, pendingLabel, next, collectName }: CredentialsFormProps) {
  const [state, formAction, isPending] = useActionState<AuthActionResult, FormData>(action, {});
  const [showPassword, setShowPassword] = useState(false);

  return (
    <form action={formAction} className="space-y-4">
      {next ? <input type="hidden" name="next" value={next} /> : null}
      {collectName ? (
        <div className="space-y-2">
          <Label htmlFor="fullName" className="text-brand-n-700">
            Your name
          </Label>
          <Input id="fullName" name="fullName" type="text" autoComplete="name" required maxLength={120} />
        </div>
      ) : null}
      <div className="space-y-2">
        <Label htmlFor="email" className="text-brand-n-700">
          Email address
        </Label>
        <Input id="email" name="email" type="email" autoComplete="email" required />
      </div>
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label htmlFor="password" className="text-brand-n-700">
            Your password
          </Label>
          <button
            type="button"
            onClick={() => setShowPassword((value) => !value)}
            className="text-xs font-medium text-brand-n-500 hover:text-brand-teal-600"
          >
            {showPassword ? "Hide" : "Show"}
          </button>
        </div>
        <Input
          id="password"
          name="password"
          type={showPassword ? "text" : "password"}
          autoComplete="current-password"
          required
          minLength={6}
        />
      </div>
      {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}
      <Button type="submit" className="w-full rounded-full" disabled={isPending}>
        {isPending ? pendingLabel : submitLabel}
      </Button>
    </form>
  );
}
