import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { createClient } from "@/lib/supabase/server";
import { AsyncButton } from "@/components/dashboard/async-button";
import { ConfirmActionButton } from "@/components/dashboard/confirm-action-button";
import { completeActionItem, dismissActionItem } from "./actions";

const PRIORITY_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  urgent: "destructive",
  high: "destructive",
  medium: "secondary",
  low: "outline",
};

export default async function ActionItemsPage({
  params,
}: {
  params: Promise<{ workspaceId: string; projectId: string }>;
}) {
  const { workspaceId, projectId } = await params;
  const supabase = await createClient();

  const { data: items } = await supabase
    .from("action_items")
    .select("id, title, description, kind, priority, confidence_score, status, for_date, owner_hint")
    .eq("project_id", projectId)
    .in("status", ["pending", "in_progress"])
    .order("for_date", { ascending: false })
    .order("priority", { ascending: false });

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <h1 className="text-lg font-semibold">Action items</h1>

      {!items || items.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No open action items yet. They appear here once a connected integration syncs and the AI pipeline finds
          something worth surfacing.
        </p>
      ) : (
        <div className="space-y-3">
          {items.map((item) => (
            <Card key={item.id}>
              <CardHeader className="flex flex-row items-start justify-between gap-2">
                <div>
                  <CardTitle className="text-base">{item.title}</CardTitle>
                  <CardDescription>
                    {item.kind} · {item.for_date} {item.owner_hint ? `· ${item.owner_hint}` : ""}
                  </CardDescription>
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant={PRIORITY_VARIANT[item.priority] ?? "outline"}>{item.priority}</Badge>
                  <Badge variant="outline">{Math.round(item.confidence_score * 100)}% confidence</Badge>
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                {item.description ? <p className="text-sm text-muted-foreground">{item.description}</p> : null}
                <div className="flex gap-2">
                  <AsyncButton
                    action={completeActionItem.bind(null, workspaceId, projectId, item.id)}
                    loadingMessage="Marking as done…"
                    size="sm"
                    data-testid={`complete-${item.id}`}
                  >
                    Complete
                  </AsyncButton>
                  <ConfirmActionButton
                    action={dismissActionItem.bind(null, workspaceId, projectId, item.id)}
                    triggerLabel="Dismiss"
                    confirmLabel="Dismiss"
                    loadingMessage="Dismissing…"
                    title="Dismiss this action item?"
                    description="It will be removed from your open items. This can't be undone from the UI."
                    data-testid={`dismiss-${item.id}`}
                  />
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
