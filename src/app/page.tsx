import { redirect } from "next/navigation";
import { getUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

export default async function RootPage() {
  const user = await getUser();
  if (!user) {
    redirect("/login");
  }

  const supabase = await createClient();
  const { data: workspaces } = await supabase
    .from("workspaces")
    .select("id")
    .order("created_at", { ascending: true })
    .limit(1);

  if (workspaces && workspaces.length > 0) {
    redirect(`/w/${workspaces[0].id}`);
  }

  // No workspace. Two very different reasons, and conflating them was a bug:
  //
  //   already in a tenant  -> a billing admin, invited to the organisation
  //                           alone. Their whole surface is /org.
  //   in no tenant at all  -> a genuinely new signup, who needs onboarding.
  //
  // Sending the first case to /onboarding had them create a SECOND
  // organisation and silently orphan the membership they were invited to.
  const { data: tenant } = await supabase.from("tenants").select("id").limit(1).maybeSingle();
  redirect(tenant ? "/org" : "/onboarding");
}
