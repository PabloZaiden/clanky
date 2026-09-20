import type { UseMeshResult } from "../../hooks";
import { MeshSettingsContent } from "./mesh-settings-content";
import { RelaySettingsContent } from "./relay-settings-content";

export function LinkedInstancesSettingsSection({ mesh }: { mesh: UseMeshResult }) {
  return (
    <details className="overflow-hidden rounded-xl border border-gray-200 bg-white dark:border-gray-800 dark:bg-neutral-950">
      <summary className="cursor-pointer px-4 py-3 text-sm font-semibold text-gray-900 dark:text-gray-100">
        <span className="flex items-center justify-between gap-3">
          <span>Linked instances</span>
        </span>
      </summary>
      <div className="border-t border-gray-200 p-4 dark:border-gray-800">
        <MeshSettingsContent mesh={mesh} />
        <div className="mt-6 border-t border-gray-200 pt-6 dark:border-gray-800">
          <h3 className="mb-3 text-sm font-medium text-gray-900 dark:text-gray-100">Worker relay</h3>
          <RelaySettingsContent />
        </div>
      </div>
    </details>
  );
}
