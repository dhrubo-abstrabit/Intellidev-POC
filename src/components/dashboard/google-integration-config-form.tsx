"use client";

import { useActionState } from "react";
import { ChevronDownIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Collapsible, CollapsibleTrigger, CollapsiblePanel } from "@/components/ui/collapsible";
import { renderConfigField } from "@/components/dashboard/integration-config-form";
import {
  saveIntegrationConfig,
  type SaveIntegrationConfigResult,
} from "@/app/(app)/w/[workspaceId]/p/[projectId]/integrations/actions";
import type { ConfigFieldSpec } from "@/lib/db/schemas/integration-config";

/** Mirrors GoogleConfigSection in connectors/google/config.ts — redeclared
 * (not imported) because that module is `server-only`; the server page passes
 * the real sections down as a prop. */
export interface GoogleConfigFormSection {
  key: string;
  label: string;
  helpText: string;
  fields: ConfigFieldSpec[];
}

/**
 * The one connector that doesn't render through IntegrationConfigForm: a
 * single Google grant covers three sub-services, each with its own scope, so
 * the form is three independently-togglable sections submitted together
 * rather than one flat field list.
 *
 * Inputs are namespaced `<section>.<fieldKey>`; saveIntegrationConfig splits
 * them back apart (see parseGoogleFieldsFromFormData). Panels are
 * `keepMounted` so a collapsed section still submits its values — collapsing
 * Drive must not silently clear the folder list.
 */
export function GoogleIntegrationConfigForm({
  workspaceId,
  projectId,
  integrationId,
  sections,
  config,
}: {
  workspaceId: string;
  projectId: string;
  integrationId: string;
  sections: GoogleConfigFormSection[];
  config: Record<string, unknown>;
}) {
  const boundAction = saveIntegrationConfig.bind(null, workspaceId, projectId, integrationId);
  const [state, formAction, isPending] = useActionState<SaveIntegrationConfigResult, FormData>(boundAction, {});

  return (
    <form action={formAction} className="space-y-3 border-t pt-3">
      {sections.map((section) => {
        const raw = config[section.key];
        // null / absent / anything non-object (a hand-written jsonb value)
        // all read as "this service is off".
        const sectionConfig =
          raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
        const enabledId = `${integrationId}-${section.key}-enabled`;

        return (
          <Collapsible key={section.key} defaultOpen={sectionConfig !== null} className="rounded-md border p-2.5">
            <div className="flex items-start justify-between gap-2">
              <div className="flex items-start gap-2">
                <input
                  id={enabledId}
                  name={`${section.key}.enabled`}
                  type="checkbox"
                  defaultChecked={sectionConfig !== null}
                  className="mt-0.5 h-4 w-4 rounded border-input"
                  data-testid={`enable-${section.key}`}
                />
                <div>
                  <Label htmlFor={enabledId}>Enable {section.label}</Label>
                  <p className="text-xs text-muted-foreground">{section.helpText}</p>
                </div>
              </div>
              <CollapsibleTrigger
                className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                aria-label={`Toggle ${section.label} settings`}
                data-testid={`toggle-${section.key}-config`}
              >
                <ChevronDownIcon className="size-4 transition-transform group-data-panel-open:rotate-180" />
              </CollapsibleTrigger>
            </div>
            <CollapsiblePanel keepMounted>
              <div className="space-y-3 pt-3 pl-6">
                {section.fields.map((field) =>
                  renderConfigField(
                    field,
                    `${section.key}.${field.key}`,
                    sectionConfig?.[field.key],
                    `${integrationId}-${section.key}-${field.key}`,
                  ),
                )}
              </div>
            </CollapsiblePanel>
          </Collapsible>
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
