"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  saveIntegrationConfig,
  type SaveIntegrationConfigResult,
} from "@/app/(app)/w/[workspaceId]/p/[projectId]/integrations/actions";
import type { ConfigFieldSpec } from "@/lib/db/schemas/integration-config";

/**
 * Renders a form from a declarative field-spec list — this repo has no
 * generic <Form>/<FormField> component (see src/components/ui/), and each
 * connector's scope looks different enough (Chat: a list of space ids;
 * Drive: a list of folder/drive URLs plus numeric knobs and a text-export
 * toggle; Gmail: a single search query plus toggles) that one bespoke
 * component per provider would mostly duplicate this one. `currentValues`
 * seeds each field from the integration's saved config, if any.
 */
export function IntegrationConfigForm({
  workspaceId,
  projectId,
  integrationId,
  fields,
  currentValues,
}: {
  workspaceId: string;
  projectId: string;
  integrationId: string;
  fields: ConfigFieldSpec[];
  currentValues: Record<string, unknown>;
}) {
  const boundAction = saveIntegrationConfig.bind(null, workspaceId, projectId, integrationId);
  const [state, formAction, isPending] = useActionState<SaveIntegrationConfigResult, FormData>(boundAction, {});

  return (
    <form action={formAction} className="space-y-3 border-t pt-3">
      {fields.map((field) => {
        const fieldId = `${integrationId}-${field.key}`;
        const currentValue = currentValues[field.key];

        if (field.kind === "text-list") {
          const defaultValue = Array.isArray(currentValue) ? currentValue.join("\n") : "";
          return (
            <div key={field.key} className="space-y-1.5">
              <Label htmlFor={fieldId}>{field.label}</Label>
              <Textarea
                id={fieldId}
                name={field.key}
                rows={4}
                placeholder={field.placeholder}
                defaultValue={defaultValue}
                data-testid={`config-${field.key}`}
              />
              {field.helpText ? <p className="text-xs text-muted-foreground">{field.helpText}</p> : null}
            </div>
          );
        }

        if (field.kind === "number") {
          return (
            <div key={field.key} className="space-y-1.5">
              <Label htmlFor={fieldId}>{field.label}</Label>
              <Input
                id={fieldId}
                name={field.key}
                type="number"
                min={field.min}
                max={field.max}
                defaultValue={typeof currentValue === "number" ? currentValue : undefined}
                data-testid={`config-${field.key}`}
              />
              {field.helpText ? <p className="text-xs text-muted-foreground">{field.helpText}</p> : null}
            </div>
          );
        }

        if (field.kind === "boolean") {
          const checked = typeof currentValue === "boolean" ? currentValue : field.defaultChecked ?? false;
          return (
            <div key={field.key} className="flex items-start gap-2">
              <input
                id={fieldId}
                name={field.key}
                type="checkbox"
                defaultChecked={checked}
                className="mt-0.5 h-4 w-4 rounded border-input"
                data-testid={`config-${field.key}`}
              />
              <div>
                <Label htmlFor={fieldId}>{field.label}</Label>
                {field.helpText ? <p className="text-xs text-muted-foreground">{field.helpText}</p> : null}
              </div>
            </div>
          );
        }

        return (
          <div key={field.key} className="space-y-1.5">
            <Label htmlFor={fieldId}>{field.label}</Label>
            <Input
              id={fieldId}
              name={field.key}
              type="text"
              placeholder={field.placeholder}
              defaultValue={typeof currentValue === "string" ? currentValue : ""}
              data-testid={`config-${field.key}`}
            />
            {field.helpText ? <p className="text-xs text-muted-foreground">{field.helpText}</p> : null}
          </div>
        );
      })}

      {state.error ? (
        <p className="text-sm text-destructive" aria-live="polite">
          {state.error}
        </p>
      ) : null}
      {state.message ? (
        <p className="text-sm text-muted-foreground" aria-live="polite">
          {state.message}
        </p>
      ) : null}

      <Button type="submit" size="sm" variant="outline" disabled={isPending} data-testid="save-config">
        {isPending ? "Saving…" : "Save configuration"}
      </Button>
    </form>
  );
}
