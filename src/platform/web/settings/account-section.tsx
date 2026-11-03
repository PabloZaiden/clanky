import { useId, useState } from "react";
import { VALID_LOG_LEVELS, type LogLevelName, type WebAppConfigResponse } from "@/platform/contracts";
import { appJson } from "../api-client";
import { Badge, Button, CheckboxField, ErrorState, FormSection, LoadingState, Select } from "@pablozaiden/webapp/web";
import { useLogLevel } from "../log-level";
import { SettingsFieldRow } from "@pablozaiden/webapp/web";
import { AppearanceSection } from "./appearance-section";

function isLogLevelName(value: string): value is LogLevelName {
  return VALID_LOG_LEVELS.some((level) => level === value);
}

export interface AccountSectionProps {
  config: WebAppConfigResponse;
  refresh: () => Promise<void>;
  setError: (error: string | undefined) => void;
  category: string;
}

export function AccountSection({ config, refresh, setError, category }: AccountSectionProps) {
  const logLevelId = useId();
  const logLevel = useLogLevel();
  const [logLevelSaving, setLogLevelSaving] = useState(false);
  const [serverLogsSaving, setServerLogsSaving] = useState(false);

  async function updateLogLevel(value: string) {
    if (!isLogLevelName(value)) {
      setError(`Unknown log level: ${value}`);
      return;
    }
    try {
      setError(undefined);
      setLogLevelSaving(true);
      await appJson<unknown>("/api/preferences/log-level", { method: "PUT", body: JSON.stringify({ level: value }) });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLogLevelSaving(false);
    }
  }

  async function updateServerLogs(enabled: boolean) {
    try {
      setError(undefined);
      setServerLogsSaving(true);
      await appJson<unknown>("/api/server/logs/settings", {
        method: "PUT",
        body: JSON.stringify({ enabled }),
      });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setServerLogsSaving(false);
    }
  }

  return (
    <>
      {category === "account" && config.currentUser ? (
        <FormSection title="Account">
          <p>Signed in as <strong>{config.currentUser.username}</strong> <Badge variant={config.currentUser.isAdmin ? "success" : "disabled"}>{config.currentUser.role}</Badge></p>
        </FormSection>
      ) : null}
      {category === "general" ? <AppearanceSection setError={setError} /> : null}

      {category === "administration" && config.currentUser?.isAdmin ? (
        <FormSection title="Logging">
          {logLevel.error ? (
            <ErrorState
              description={logLevel.error.message}
              action={<Button type="button" loading={logLevel.loading} onClick={() => void logLevel.retry()}>Retry</Button>}
            />
          ) : null}
          {logLevel.loading && logLevel.level === undefined ? <LoadingState title="Loading log level" /> : null}
          {logLevel.level !== undefined ? (
            <SettingsFieldRow
              title="Log level"
              description={logLevel.fromEnv ? "Controlled by environment." : undefined}
              labelFor={logLevelId}
              content={<Select
                id={logLevelId}
                value={logLevel.level}
                disabled={logLevel.fromEnv === true || logLevel.loading || logLevelSaving}
                onChange={(event) => void updateLogLevel(event.currentTarget.value)}
              >
                {VALID_LOG_LEVELS.map((level) => <option key={level} value={level}>{level}</option>)}
              </Select>}
            />
          ) : null}
          <CheckboxField
            label="Preserve logs"
            checked={config.inMemoryLogs.enabled}
            disabled={serverLogsSaving}
            onChange={(event) => void updateServerLogs(event.currentTarget.checked)}
          />
        </FormSection>
      ) : null}
    </>
  );
}
