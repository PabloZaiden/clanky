import type { UseMeshResult } from "../../hooks";
import { MeshSettingsContent } from "./mesh-settings-content";
import { RelaySettingsContent } from "./relay-settings-content";
import { Button } from "../common";

export function WorkersSettingsSection({ mesh }: { mesh: UseMeshResult }) {
  return (
    <details className="wapp-form-section group">
      <summary className="mb-3 flex cursor-pointer list-none items-center justify-between gap-3 text-sm font-medium text-gray-900 dark:text-gray-100 [&::-webkit-details-marker]:hidden">
        <span className="flex min-w-0 items-center gap-2">
          <svg
            className="h-4 w-4 shrink-0 transition-transform group-open:rotate-90"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="m6 4 4 4-4 4" />
          </svg>
          <span>Workers</span>
        </span>
        <span onClick={(event) => event.stopPropagation()}>
          <Button
            type="button"
            size="sm"
            loading={mesh.saving}
            disabled={mesh.saving}
            onClick={() => void mesh.checkHealth()}
          >
            Health check
          </Button>
        </span>
      </summary>
      <div className="wapp-form-section-body">
        <MeshSettingsContent mesh={mesh} />
        <div className="mt-6 border-t border-gray-200 pt-6 dark:border-gray-800">
          <h3 className="mb-3 text-sm font-medium text-gray-900 dark:text-gray-100">Worker relay</h3>
          <RelaySettingsContent />
        </div>
      </div>
    </details>
  );
}
