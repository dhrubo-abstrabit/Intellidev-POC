import { Badge } from "@/components/ui/badge";
import { STATUS_LABEL, type ActionItemPriority, type ActionItemStatus } from "./types";

type BadgeVariant = "default" | "secondary" | "destructive" | "outline";

const PRIORITY_VARIANT: Record<ActionItemPriority, BadgeVariant> = {
  urgent: "destructive",
  high: "destructive",
  medium: "secondary",
  low: "outline",
};

const STATUS_VARIANT: Record<ActionItemStatus, BadgeVariant> = {
  pending: "outline",
  in_progress: "secondary",
  done: "default",
  dismissed: "outline",
  snoozed: "secondary",
};

export function PriorityBadge({ priority }: { priority: ActionItemPriority }) {
  return <Badge variant={PRIORITY_VARIANT[priority]}>{priority}</Badge>;
}

export function StatusBadge({ status }: { status: ActionItemStatus }) {
  return <Badge variant={STATUS_VARIANT[status]}>{STATUS_LABEL[status]}</Badge>;
}
