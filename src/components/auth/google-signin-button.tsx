import { Button } from "@/components/ui/button";
import { signInWithGoogle } from "@/app/(auth)/actions";

export function GoogleSignInButton() {
  return (
    <form action={signInWithGoogle}>
      <Button type="submit" variant="outline" className="w-full">
        Continue with Google
      </Button>
    </form>
  );
}
