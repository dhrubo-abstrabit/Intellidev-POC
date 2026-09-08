"use client";

import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  saveSyncSchedule,
  type SaveSyncScheduleResult,
} from "@/app/(app)/w/[workspaceId]/p/[projectId]/integrations/actions";
import {
  CUSTOM_PRESET_VALUE,
  MAX_SYNC_INTERVAL_SECONDS,
  SYNC_INTERVAL_PRESETS,
  SYNC_SCHEDULE_UNITS,
  describeSchedule,
  parseScheduleParts,
  secondsToCustomParts,
  secondsToPresetValue,
  type SyncScheduleUnit,
} from "@/lib/sync/schedule";

const PRESET_SELECT_ITEMS = [
  ...SYNC_INTERVAL_PRESETS.map((preset) => ({ label: preset.label, value: preset.value })),
  { label: "Custom", value: CUSTOM_PRESET_VALUE },
];

const UNIT_SELECT_ITEMS = SYNC_SCHEDULE_UNITS.map((unit) => ({ label: unit.label, value: unit.value }));

/**
 * Sync-cadence control for one connector's Integrations card — a SIBLING of
 * IntegrationConfigForm/GoogleIntegrationConfigForm (see page.tsx), never
 * nested inside them: this posts to a separate Server Action
 * (saveSyncSchedule) precisely so a schedule change never touches the
 * scope-change / cursor-invalidation logic those forms' action does.
 *
 * Controlled (useState), unlike the config forms' uncontrolled +
 * `defaultValue` + remount-on-key pattern: a CSS-hidden but still-mounted
 * `type="number"` with `min`/`max` is still constraint-validated by the
 * browser, so conditionally UNMOUNTING the custom fields (which controlled
 * state makes possible without losing what the user typed when they toggle
 * back) is what avoids Chrome's "An invalid form control is not focusable"
 * submit-blocking error. Controlled state is also what powers the live
 * range-check message below, the whole point of allowing an arbitrary custom
 * interval in the first place.
 */
export function SyncScheduleForm({
  workspaceId,
  projectId,
  integrationId,
  provider,
  syncIntervalSeconds,
  syncEnabled,
}: {
  workspaceId: string;
  projectId: string;
  integrationId: string;
  provider: string;
  syncIntervalSeconds: number;
  syncEnabled: boolean;
}) {
  const boundAction = saveSyncSchedule.bind(null, workspaceId, projectId, integrationId);
  const [state, formAction, isPending] = useActionState<SaveSyncScheduleResult, FormData>(boundAction, {});

  const [preset, setPreset] = useState<string>(() => secondsToPresetValue(syncIntervalSeconds));
  // Seeded unconditionally (even when a preset is currently active) so
  // switching to Custom shows a sensible starting value instead of an empty
  // box — see secondsToCustomParts' own doc comment.
  const initialCustom = secondsToCustomParts(syncIntervalSeconds);
  const [customAmount, setCustomAmount] = useState<string>(String(initialCustom.amount));
  const [customUnit, setCustomUnit] = useState<SyncScheduleUnit>(initialCustom.unit);
  const [enabled, setEnabled] = useState<boolean>(syncEnabled);

  const isCustom = preset === CUSTOM_PRESET_VALUE;
  const clientParse = parseScheduleParts(preset, customAmount, customUnit);
  const maxAmount = Math.floor(MAX_SYNC_INTERVAL_SECONDS / (customUnit === "hours" ? 3600 : 60));

  return (
    <form action={formAction} className="space-y-3 border-t pt-3">
      <div className="space-y-1.5">
        <Label htmlFor={`${integrationId}-sync-preset`}>Sync schedule</Label>
        <Select name="syncPreset" items={PRESET_SELECT_ITEMS} value={preset} onValueChange={(value) => setPreset(value as string)}>
          <SelectTrigger id={`${integrationId}-sync-preset`} size="sm" className="w-full" data-testid={`sync-preset-${provider}`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SYNC_INTERVAL_PRESETS.map((option) => (
              <SelectItem key={option.value} value={option.value} data-testid={`sync-preset-option-${option.value}`}>
                {option.label}
              </SelectItem>
            ))}
            <SelectItem value={CUSTOM_PRESET_VALUE} data-testid={`sync-preset-option-${CUSTOM_PRESET_VALUE}`}>
              Custom
            </SelectItem>
          </SelectContent>
        </Select>
      </div>

      {isCustom ? (
        <div className="flex items-end gap-2">
          <div className="space-y-1.5">
            <Label htmlFor={`${integrationId}-sync-custom-amount`}>Every</Label>
            <Input
              id={`${integrationId}-sync-custom-amount`}
              name="syncCustomAmount"
              type="number"
              min={1}
              max={maxAmount}
              step={1}
              value={customAmount}
              onChange={(e) => setCustomAmount(e.target.value)}
              className="w-20"
              data-testid={`sync-custom-amount-${provider}`}
            />
          </div>
          <Select
            name="syncCustomUnit"
            items={UNIT_SELECT_ITEMS}
            value={customUnit}
            onValueChange={(value) => setCustomUnit(value as SyncScheduleUnit)}
          >
            <SelectTrigger size="sm" aria-label="Interval unit" data-testid={`sync-custom-unit-${provider}`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SYNC_SCHEDULE_UNITS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : null}

      <p className="text-xs text-muted-foreground" data-testid={`sync-schedule-summary-${provider}`}>
        {clientParse.ok ? describeSchedule(clientParse.intervalSeconds, enabled) : clientParse.error}
      </p>

      <div className="flex items-start gap-2">
        <input
          id={`${integrationId}-sync-enabled`}
          name="syncEnabled"
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
          className="mt-0.5 h-4 w-4 rounded border-input"
          data-testid={`sync-enabled-${provider}`}
        />
        <Label htmlFor={`${integrationId}-sync-enabled`}>Sync automatically on this schedule</Label>
      </div>

      {state.error ? (
        <p className="text-sm text-destructive" aria-live="polite" data-testid={`sync-schedule-error-${provider}`}>
          {state.error}
        </p>
      ) : null}
      {state.message ? (
        <p className="text-sm text-muted-foreground" aria-live="polite" data-testid={`sync-schedule-message-${provider}`}>
          {state.message}
        </p>
      ) : null}

      <Button
        type="submit"
        size="sm"
        variant="outline"
        disabled={isPending || !clientParse.ok}
        data-testid={`save-sync-schedule-${provider}`}
      >
        {isPending ? "Saving…" : "Save schedule"}
      </Button>
    </form>
  );
}
