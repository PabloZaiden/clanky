/**
 * Resolve transcript SQL identifiers from the canonical schema inventory.
 *
 * New transcript tables must be classified there with matching resource and
 * role metadata; this module intentionally owns no independent table list.
 */
import {
  SCHEMA_TABLE_INVENTORY,
  type SchemaTranscriptResource,
  type SchemaTranscriptTableMetadata,
} from "../schema-inventory";
import type {
  TranscriptResource,
  TranscriptTableConfig,
} from "./types";

function findTranscriptTable(
  resource: TranscriptResource,
  role: SchemaTranscriptTableMetadata["role"],
): SchemaTranscriptTableMetadata & { name: string } {
  const matches = SCHEMA_TABLE_INVENTORY.filter((table) => {
    const transcript = table.transcript;
    return transcript !== undefined
      && transcript.resource === resource
      && transcript.role === role;
  });
  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one ${role} transcript table for ${resource}, found ${matches.length}`,
    );
  }

  const table = matches[0]!;
  const transcript = table.transcript!;
  if (
    table.category !== "clanky"
    || !table.expectedInFreshSchema
    || !table.introspectable
    || !table.resettable
  ) {
    throw new Error(
      `Transcript table ${table.name} for ${resource} is not a current Clanky table`,
    );
  }
  return { name: table.name, ...transcript };
}

function createTranscriptTableConfig(
  resource: TranscriptResource,
): TranscriptTableConfig {
  const entries = findTranscriptTable(resource, "entries");
  const meta = findTranscriptTable(resource, "meta");
  if (
    entries.parentTable !== meta.parentTable
    || entries.resourceColumn !== meta.resourceColumn
  ) {
    throw new Error(`Transcript table metadata mismatch for ${resource}`);
  }

  return {
    parentTable: entries.parentTable,
    entriesTable: entries.name,
    metaTable: meta.name,
    resourceColumn: entries.resourceColumn,
  };
}

const TRANSCRIPT_TABLE_CONFIGS: Readonly<
  Record<SchemaTranscriptResource, TranscriptTableConfig>
> = {
  chat: createTranscriptTableConfig("chat"),
  task: createTranscriptTableConfig("task"),
  agent_run: createTranscriptTableConfig("agent_run"),
};

export function getTranscriptTableConfig(
  resource: TranscriptResource,
): TranscriptTableConfig {
  return TRANSCRIPT_TABLE_CONFIGS[resource];
}
