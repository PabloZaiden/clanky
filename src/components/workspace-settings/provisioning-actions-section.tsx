/**
 * Provisioning-related workspace settings actions.
 */

import { ActionMenu } from "@pablozaiden/webapp/web";

interface ProvisioningActionsSectionProps {
  onRestart: () => void;
  onRebuild: () => void;
}

export function ProvisioningActionsSection({
  onRestart,
  onRebuild,
}: ProvisioningActionsSectionProps) {
  return (
    <div className="border-t border-gray-200 pt-6 dark:border-gray-700">
      <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 dark:border-amber-900 dark:bg-amber-950/20">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-sm font-medium text-amber-900 dark:text-amber-100">
            Provisioned Workspace Actions
          </h3>
          <ActionMenu
            ariaLabel="Provisioned workspace actions"
            triggerVariant="ghost"
            triggerSize="compact"
            items={[
              { id: "restart", label: "Restart", onAction: onRestart },
              { id: "rebuild", label: "Rebuild", onAction: onRebuild },
            ]}
          />
        </div>
      </div>
    </div>
  );
}
