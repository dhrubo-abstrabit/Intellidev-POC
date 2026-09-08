import Link from "next/link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { CredentialsForm } from "@/components/auth/credentials-form";
import { GoogleSignInButton } from "@/components/auth/google-signin-button";
import { signUpWithPassword } from "@/app/(auth)/actions";

export default async function SignupPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  // proxy.ts sets ?next= when it bounces an unauthenticated request, and the
  // invite page sets it when sending a signed-out recipient here. Passing it
  // through keeps someone on the path they were actually trying to follow.
  const { next } = await searchParams;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Create an account</CardTitle>
        <CardDescription>Start building your project intelligence workspace.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <GoogleSignInButton />
        <div className="flex items-center gap-3">
          <Separator className="flex-1" />
          <span className="text-xs text-muted-foreground">OR</span>
          <Separator className="flex-1" />
        </div>
        <CredentialsForm action={signUpWithPassword} next={next} collectName submitLabel="Sign up" pendingLabel="Signing up..." />
        <p className="text-center text-sm text-muted-foreground">
          Already have an account?{" "}
          <Link href="/login" className="font-medium text-foreground underline underline-offset-4">
            Log in
          </Link>
        </p>
      </CardContent>
    </Card>
  );
}
