/**
 * Provisioning-related workspace settings actions.
 */

import { Button } from "../common";

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
        <h3 className="mb-3 text-sm font-medium text-amber-900 dark:text-amber-100">
          Provisioned Workspace Actions
        </h3>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="secondary" size="sm" onClick={onRestart}>
            Restart
          </Button>
          <Button type="button" variant="secondary" size="sm" onClick={onRebuild}>
            Rebuild
          </Button>
        </div>
      </div>
    </div>
  );
}
