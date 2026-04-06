import type { BadgeVariant } from "../common";
import { Badge, Button } from "../common";
import type { SshServerPrerequisiteReport } from "../../types";

interface SshServerPrerequisitesSectionProps {
  checking: boolean;
  error: string | null;
  report: SshServerPrerequisiteReport | null;
  onCheck: () => Promise<void>;
}

function getSummaryVariant(status: SshServerPrerequisiteReport["summary"]["status"]): BadgeVariant {
  switch (status) {
    case "ready":
      return "success";
    case "missing_requirements":
      return "warning";
    case "connection_failed":
      return "error";
  }
}

function getSummaryLabel(status: SshServerPrerequisiteReport["summary"]["status"]): string {
  switch (status) {
    case "ready":
      return "Ready";
    case "missing_requirements":
      return "Missing requirements";
    case "connection_failed":
      return "Connection failed";
  }
}

function getCheckVariant(status: SshServerPrerequisiteReport["checks"][number]["status"]): BadgeVariant {
  switch (status) {
    case "available":
      return "success";
    case "missing":
      return "error";
    case "unknown":
      return "warning";
    case "not_applicable":
    default:
      return "default";
  }
}

function getCheckLabel(status: SshServerPrerequisiteReport["checks"][number]["status"]): string {
  switch (status) {
    case "available":
      return "Available";
    case "missing":
      return "Missing";
    case "unknown":
      return "Unknown";
    case "not_applicable":
      return "Not applicable";
  }
}

export function SshServerPrerequisitesSection({
  checking,
  error,
  report,
  onCheck,
}: SshServerPrerequisitesSectionProps) {
  return (
    <section className="space-y-4 rounded-2xl border border-gray-200 bg-gray-50 p-5 dark:border-gray-800 dark:bg-neutral-950/50">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <h2 className="text-base font-semibold text-gray-950 dark:text-gray-100">Server prerequisites</h2>
          <p className="text-sm text-gray-600 dark:text-gray-400">
            Check whether this host exposes the tools Ralpher expects for standalone SSH,
            persistent sessions, and automatic provisioning.
          </p>
        </div>
        <Button type="button" size="sm" variant="secondary" loading={checking} onClick={() => void onCheck()}>
          Check prerequisites
        </Button>
      </div>

      {!report && !error && (
        <p className="text-sm text-gray-600 dark:text-gray-400">
          This check verifies SSH connectivity, <code>bash</code>, <code>dtach</code>, and the automatic provisioning
          toolchain: <code>devbox</code>, <code>docker</code>, <code>devcontainer</code>, <code>git</code>, and{" "}
          <code>gh</code>.
        </p>
      )}

      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-300">
          {error}
        </div>
      )}

      {report && (
        <div className="space-y-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={getSummaryVariant(report.summary.status)}>
                {getSummaryLabel(report.summary.status)}
              </Badge>
              <Badge variant="default">
                {report.summary.availableCount} available
              </Badge>
              {report.summary.missingCount > 0 && (
                <Badge variant="error">{report.summary.missingCount} missing</Badge>
              )}
              {report.summary.unknownCount > 0 && (
                <Badge variant="warning">{report.summary.unknownCount} unknown</Badge>
              )}
              {report.summary.notApplicableCount > 0 && (
                <Badge variant="default">{report.summary.notApplicableCount} not applicable</Badge>
              )}
            </div>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              Checked {new Date(report.checkedAt).toLocaleString()}
            </p>
          </div>

          <div className="space-y-3">
            {report.checks.map((check) => (
              <div
                key={check.id}
                className="rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-neutral-900"
              >
                <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                  <div className="space-y-1">
                    <h3 className="text-sm font-medium text-gray-950 dark:text-gray-100">{check.label}</h3>
                    <p className="text-xs text-gray-500 dark:text-gray-400">
                      Used for {check.requiredFor.join(", ")}.
                    </p>
                  </div>
                  <Badge variant={getCheckVariant(check.status)}>{getCheckLabel(check.status)}</Badge>
                </div>
                <p className="mt-3 text-sm text-gray-700 dark:text-gray-300">{check.details}</p>
                {check.installHint && (
                  <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
                    <span className="font-medium text-gray-800 dark:text-gray-200">Install hint:</span>{" "}
                    {check.installHint}
                  </p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
