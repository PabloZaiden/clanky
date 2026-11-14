import type { Database } from "bun:sqlite";
import { createLogger } from "@pablozaiden/webapp/server";
import { createAgentSettings, getHarnessAdapterForProvider, isAgentProvider } from "@/shared/settings";

const log = createLogger("persistence:retire-harness-transport");

export function retireHarnessTransport(db: Database): void {
  const rows = db.query<{ id: string; name: string; server_settings: string }, []>(
    "SELECT id, name, server_settings FROM workspaces",
  ).all();
  const update = db.query("UPDATE workspaces SET server_settings = ? WHERE id = ?");
  for (const row of rows) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.server_settings);
    } catch (error) {
      log.warn("Cannot migrate corrupt workspace harness settings", { workspaceId: row.id, error: String(error) });
      continue;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      log.warn("Cannot migrate invalid workspace harness settings", { workspaceId: row.id });
      continue;
    }
    const settings = parsed as Record<string, unknown>;
    const agent = settings["agent"];
    if (!agent || typeof agent !== "object" || Array.isArray(agent)) {
      log.warn("Cannot migrate invalid workspace harness settings", { workspaceId: row.id });
      continue;
    }
    const selection = agent as Record<string, unknown>;
    if (selection["adapter"] !== "acp") continue;
    const provider = selection["provider"];
    if (!isAgentProvider(provider)) {
      throw new Error(
        `Workspace "${row.name}" uses a retired harness provider (${String(provider)}). ` +
        "Select Copilot, Codex or OpenCode 2 with the previous application version before upgrading.",
      );
    }
    update.run(JSON.stringify({
      ...settings,
      agent: createAgentSettings(getHarnessAdapterForProvider(provider)),
    }), row.id);
  }

  const jobs = db.query<{ id: string; config_json: string }, []>(
    "SELECT id, config_json FROM provisioning_jobs",
  ).all();
  const updateJob = db.query("UPDATE provisioning_jobs SET config_json = ? WHERE id = ?");
  for (const job of jobs) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(job.config_json);
    } catch (error) {
      log.warn("Cannot migrate corrupt provisioning harness settings", { jobId: job.id, error: String(error) });
      continue;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      log.warn("Cannot migrate invalid provisioning harness settings", { jobId: job.id });
      continue;
    }
    const config = parsed as Record<string, unknown>;
    if (config["adapter"] !== undefined && config["adapter"] !== "acp") continue;
    const provider = config["provider"];
    if (!isAgentProvider(provider)) {
      log.warn("Retaining a provisioning snapshot with an unsupported harness", { jobId: job.id });
      continue;
    }
    updateJob.run(JSON.stringify({
      ...config,
      ...createAgentSettings(getHarnessAdapterForProvider(provider)),
    }), job.id);
  }
}
