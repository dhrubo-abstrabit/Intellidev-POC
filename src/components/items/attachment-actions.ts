"use server";

import { requireUser } from "@/lib/auth";
import { assertProjectScope } from "@/lib/scope";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";

// Long enough to cover the network round-trip plus the click that opens the
// returned URL in a new tab; short enough that a copied/leaked link is only
// useful briefly. Minted fresh on every click rather than cached, so there's
// no "was this generated 10 minutes ago" question to reason about.
const ATTACHMENT_PREVIEW_TTL_SECONDS = 120;

/**
 * Mints a short-lived signed URL for one attachment's bytes in the private
 * 'attachments' Storage bucket — see that bucket's own migration comment for
 * why this didn't exist before: the bucket has zero storage.objects
 * policies, so only the service-role client can generate a signed URL for it
 * at all. Authorization instead rides on event_attachments' own RLS select
 * policy (workspace membership): the row lookup below uses the user-scoped
 * client, so a caller who can't see this attachment gets `null` back and
 * never reaches the service-role client underneath.
 *
 * Lives here (not under a single route's actions.ts) because both the
 * Project Data tab (DayLinkage) and Task Tracking's detail sheet
 * (TaskDetailSheet) need it — the same normalized_events/event_attachments
 * rows, surfaced via two different routes in.
 */
export async function getAttachmentPreviewUrl(
  workspaceId: string,
  projectId: string,
  attachmentId: string,
): Promise<{ url: string }> {
  await requireUser();
  const scope = await assertProjectScope(workspaceId, projectId);

  const supabase = await createClient();
  const { data: attachment } = await supabase
    .from("event_attachments")
    .select("storage_path, status")
    .eq("id", attachmentId)
    .eq("client_space_id", scope.clientSpaceId)
    .maybeSingle();
  if (!attachment) throw new Error("Attachment not found.");
  if (!attachment.storage_path) throw new Error("This attachment hasn't been downloaded yet.");

  const service = createServiceClient();
  const { data, error } = await service.storage
    .from("attachments")
    .createSignedUrl(attachment.storage_path, ATTACHMENT_PREVIEW_TTL_SECONDS);
  if (error || !data?.signedUrl) throw new Error("Could not generate a preview link.");

  return { url: data.signedUrl };
}
