import { Badge } from "@/components/ui/badge";
import { createClient } from "@/lib/supabase/server";

const ACTIVITY_PAGE_SIZE = 50;

export default async function ActivityPage({
  params,
}: {
  params: Promise<{ workspaceId: string; projectId: string }>;
}) {
  const { projectId } = await params;
  const supabase = await createClient();

  const { data: events } = await supabase
    .from("normalized_events")
    .select("id, type, provider, actor_display, actor, title, body, occurred_at")
    .eq("project_id", projectId)
    .order("occurred_at", { ascending: false })
    .limit(ACTIVITY_PAGE_SIZE);

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <h1 className="text-lg font-semibold">Recent activity</h1>

      {!events || events.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No activity yet — connect an integration and sync to see events here.
        </p>
      ) : (
        <ol className="space-y-3">
          {events.map((event) => (
            <li key={event.id} className="border-l-2 border-border pl-4">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Badge variant="outline" className="capitalize">
                  {event.provider}
                </Badge>
                <span>{event.type}</span>
                <span>·</span>
                <span>{new Date(event.occurred_at).toLocaleString()}</span>
              </div>
              <p className="text-sm">
                <span className="font-medium">{event.actor_display ?? event.actor ?? "Unknown"}</span>
                {event.title ? ` — ${event.title}` : ""}
              </p>
              {event.body ? <p className="text-sm text-muted-foreground">{event.body}</p> : null}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
