import type { RuntimeEnvironment, WebAppPersistedConfig } from "../server/runtime-config";

export type WebAppServeOptionType = "boolean" | "number" | "string";
export type WebAppServeOptionValue = boolean | number | string;

interface WebAppServeOptionDefinitionBase {
  name: string;
  description: string;
}

export type WebAppServeOptionDefinition =
  | (WebAppServeOptionDefinitionBase & {
      type: "boolean";
      defaultValue?: boolean;
    })
  | (WebAppServeOptionDefinitionBase & {
      type: "number";
      defaultValue?: number;
    })
  | (WebAppServeOptionDefinitionBase & {
      type: "string";
      defaultValue?: string;
    });

export type WebAppServeOptionValues = Readonly<
  Record<string, WebAppServeOptionValue | undefined>
>;

const RESERVED_SERVE_OPTION_NAMES = new Set([
  "dev",
  "help",
  "host",
  "port",
  "profile",
]);

function environmentName(envPrefix: string, name: string): string {
  return `${envPrefix}_${name.replaceAll("-", "_").toUpperCase()}`;
}

function valueMatchesType(
  value: WebAppServeOptionValue,
  type: WebAppServeOptionType,
): boolean {
  return typeof value === type && (type !== "number" || Number.isFinite(value));
}

export function validateServeOptionDefinitions(
  definitions: readonly WebAppServeOptionDefinition[] | undefined,
): readonly WebAppServeOptionDefinition[] {
  if (!definitions) return [];
  const names = new Set<string>();
  for (const definition of definitions) {
    if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(definition.name)) {
      throw new Error(
        `serve option name must use lowercase kebab-case; received "${definition.name}"`,
      );
    }
    if (RESERVED_SERVE_OPTION_NAMES.has(definition.name)) {
      throw new Error(`serve option name is reserved: ${definition.name}`);
    }
    if (names.has(definition.name)) {
      throw new Error(`serve option name is duplicated: ${definition.name}`);
    }
    names.add(definition.name);
    if (!definition.description.trim()) {
      throw new Error(`serve option ${definition.name} requires a description`);
    }
    if (
      definition.defaultValue !== undefined
      && !valueMatchesType(definition.defaultValue, definition.type)
    ) {
      throw new Error(
        `serve option ${definition.name} default must be ${definition.type}`,
      );
    }
  }
  return definitions;
}

export function parseServeOptionText(
  definition: WebAppServeOptionDefinition,
  raw: string,
  source: string,
): WebAppServeOptionValue {
  if (definition.type === "string") {
    return raw;
  }
  if (definition.type === "number") {
    const value = Number(raw);
    if (!raw.trim() || !Number.isFinite(value)) {
      throw new Error(`${source} must be a finite number; received "${raw}"`);
    }
    return value;
  }
  const normalized = raw.trim().toLowerCase();
  if (normalized === "true" || normalized === "1" || normalized === "yes") {
    return true;
  }
  if (normalized === "false" || normalized === "0" || normalized === "no") {
    return false;
  }
  throw new Error(`${source} must be true or false; received "${raw}"`);
}

function parsePersistedServeOption(
  definition: WebAppServeOptionDefinition,
  value: unknown,
): WebAppServeOptionValue {
  if (
    (definition.type === "string" && typeof value === "string")
    || (definition.type === "boolean" && typeof value === "boolean")
    || (
      definition.type === "number"
      && typeof value === "number"
      && Number.isFinite(value)
    )
  ) {
    return value;
  }
  throw new Error(
    `Invalid web app config: serve.options.${definition.name} must be ${definition.type}`,
  );
}

export function serializeServeOptionValue(value: WebAppServeOptionValue): string {
  return String(value);
}

export function resolveServeOptionValues(input: {
  definitions: readonly WebAppServeOptionDefinition[] | undefined;
  envPrefix: string;
  environment: RuntimeEnvironment;
  persisted: WebAppPersistedConfig;
  overrides?: Readonly<Record<string, WebAppServeOptionValue>>;
}): WebAppServeOptionValues {
  const definitions = validateServeOptionDefinitions(input.definitions);
  const persistedValues: Record<string, WebAppServeOptionValue | undefined> = {};
  for (const definition of definitions) {
    const persistedValue = input.persisted.serve?.options?.[definition.name];
    persistedValues[definition.name] = persistedValue === undefined
      ? undefined
      : parsePersistedServeOption(definition, persistedValue);
  }
  const values: Record<string, WebAppServeOptionValue | undefined> = {};
  for (const definition of definitions) {
    const override = input.overrides?.[definition.name];
    if (override !== undefined) {
      values[definition.name] = override;
      continue;
    }
    const envKey = environmentName(input.envPrefix, definition.name);
    const environmentValue = input.environment[envKey];
    if (environmentValue !== undefined) {
      values[definition.name] = parseServeOptionText(
        definition,
        environmentValue,
        envKey,
      );
      continue;
    }
    const persistedValue = persistedValues[definition.name];
    if (persistedValue !== undefined) {
      values[definition.name] = persistedValue;
      continue;
    }
    values[definition.name] = definition.defaultValue;
  }
  return values;
}

export function applyServeOptionsToEnvironment(input: {
  definitions: readonly WebAppServeOptionDefinition[] | undefined;
  envPrefix: string;
  environment: RuntimeEnvironment;
  values: WebAppServeOptionValues;
}): Record<string, string | undefined> {
  const environment = { ...input.environment };
  for (const definition of validateServeOptionDefinitions(input.definitions)) {
    const value = input.values[definition.name];
    if (value !== undefined) {
      environment[environmentName(input.envPrefix, definition.name)] =
        serializeServeOptionValue(value);
    }
  }
  return environment;
}

export function serveOptionDefinition(
  definitions: readonly WebAppServeOptionDefinition[] | undefined,
  name: string,
): WebAppServeOptionDefinition | undefined {
  return validateServeOptionDefinitions(definitions).find(
    (definition) => definition.name === name,
  );
}

export function serveOptionEnvironmentName(
  envPrefix: string,
  name: string,
): string {
  return environmentName(envPrefix, name);
}
