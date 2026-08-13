import "server-only";
import { createServiceClient } from "@/lib/supabase/service";

// First use of Supabase Storage anywhere in this project — see the
// 'attachments' bucket declared in
// supabase/migrations/20260812120000_event_attachments.sql. Private, no
// storage.objects policies: only the service-role client (which bypasses
// RLS) can read or write it.
const ATTACHMENTS_BUCKET = "attachments";

/** Path convention documented on the migration's bucket comment — keeping
 * the builder here (not duplicated at each call site) is what makes that
 * comment stay true. */
export function attachmentStoragePath(params: {
  workspaceId: string;
  projectId: string;
  normalizedEventId: string;
  attachmentId: string;
}): string {
  return `${params.workspaceId}/${params.projectId}/${params.normalizedEventId}/${params.attachmentId}`;
}

export async function uploadAttachmentBytes(
  path: string,
  bytes: Buffer,
  contentType?: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const service = createServiceClient();
  const { error } = await service.storage.from(ATTACHMENTS_BUCKET).upload(path, bytes, {
    contentType: contentType ?? "application/octet-stream",
    // At-least-once job delivery means the same attachment can be uploaded
    // more than once (a retried job after a mid-run crash) — upsert makes
    // that idempotent instead of failing on "resource already exists".
    upsert: true,
  });
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}
