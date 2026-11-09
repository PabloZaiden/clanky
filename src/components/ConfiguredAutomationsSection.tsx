import type { Automation } from "@/shared";
import { DataList, ErrorState, LoadingState, Panel } from "@pablozaiden/webapp/web";
import { getAutomationStatusBadgeVariant, StateText, StatusBadge } from "./common";
import { ClankyListRow } from "./app-shell/clanky-list-row";

const MAX_CONFIGURED_AUTOMATION_PROMPT_WORDS = 20;

function summarizeAutomationPrompt(prompt: string): string {
  const words = prompt.trim().split(/\s+/, MAX_CONFIGURED_AUTOMATION_PROMPT_WORDS + 1);
  if (words.length <= MAX_CONFIGURED_AUTOMATION_PROMPT_WORDS) {
    return words.join(" ");
  }
  return `${words.slice(0, MAX_CONFIGURED_AUTOMATION_PROMPT_WORDS).join(" ")}…`;
}

function formatDate(value?: string): string {
  if (!value) {
    return "Not scheduled";
  }
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function AutomationStatusPill({ status }: { status: string }) {
  return (
    <StatusBadge variant={getAutomationStatusBadgeVariant(status)} size="md">
      <StateText>{status}</StateText>
    </StatusBadge>
  );
}

function getScheduleText(automation: Automation): string {
  const { value, unit } = automation.config.schedule.interval;
  const displayUnit = value === 1 ? unit.slice(0, -1) : unit;
  return `Every ${value} ${displayUnit}`;
}

export interface ConfiguredAutomationsSectionProps {
  automations: Automation[];
  loading: boolean;
  error: string | null;
  title?: string;
  description?: string;
  workspaceNamesById?: Record<string, string>;
  onSelectAutomation?: (automationId: string) => void;
  isAutomationPrivateHidden?: (automation: Automation) => boolean;
  panelClassName?: string;
}

export function ConfiguredAutomationsSection({
  automations,
  loading,
  error,
  title = "Configured Automations",
  description,
  workspaceNamesById = {},
  onSelectAutomation,
  isAutomationPrivateHidden = () => false,
  panelClassName,
}: ConfiguredAutomationsSectionProps) {
  if (!loading && !error && automations.length === 0) {
    return null;
  }

  return (
    <Panel
      data-testid="configured-automations-section"
      title={title}
      description={description}
      className={panelClassName}
    >
      {error ? <ErrorState title="Unable to load automations" description={error} /> : null}
      {loading ? <LoadingState title="Loading automations" /> : null}
      {automations.length > 0 ? (
        <DataList>
          {automations.map((automation) => {
            const workspaceName = workspaceNamesById[automation.config.workspaceId];
            const privateHidden = isAutomationPrivateHidden(automation);
            return (
              <ClankyListRow
                key={automation.config.id}
                title={automation.config.name}
                description={summarizeAutomationPrompt(automation.config.prompt)}
                descriptionClassName="!mt-0 line-clamp-2"
                meta={`${workspaceName ? `${workspaceName} · ` : ""}Next run: ${formatDate(automation.state.nextRunAt)} · ${getScheduleText(automation)}`}
                metaPlacement="below"
                badge={<AutomationStatusPill status={automation.state.status} />}
                onClick={onSelectAutomation ? () => onSelectAutomation(automation.config.id) : undefined}
                privateHidden={privateHidden}
              />
            );
          })}
        </DataList>
      ) : null}
    </Panel>
  );
}
