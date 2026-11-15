import type { EnvironmentTemplateSummary } from "../../shared/execution-host-discovery";

const image = "mcr.microsoft.com/devcontainers/base:noble";
const definitions = [
  { name: "base", description: "General-purpose development tools", languages: [], feature: null, version: "system" },
  { name: "node", description: "Node.js and TypeScript", languages: ["JavaScript", "TypeScript"], feature: "ghcr.io/devcontainers/features/node:2", version: "lts" },
  { name: "bun", description: "Bun and TypeScript", languages: ["JavaScript", "TypeScript"], feature: "ghcr.io/shyim/devcontainers-features/bun:1", version: "latest" },
  { name: "python", description: "Python development", languages: ["Python"], feature: "ghcr.io/devcontainers/features/python:1", version: "latest" },
  { name: "go", description: "Go development", languages: ["Go"], feature: "ghcr.io/devcontainers/features/go:1", version: "latest" },
  { name: "rust", description: "Rust development", languages: ["Rust"], feature: "ghcr.io/devcontainers/features/rust:1", version: "latest" },
  { name: "java", description: "Java development", languages: ["Java"], feature: "ghcr.io/devcontainers/features/java:1", version: "lts" },
  { name: "dotnet", description: ".NET development", languages: ["C#"], feature: "ghcr.io/devcontainers/features/dotnet:2", version: "latest" },
] as const;

export function listEnvironmentTemplates(): EnvironmentTemplateSummary[] {
  return definitions.map((entry) => ({
    name: entry.name, description: entry.description, source: "built-in",
    base: "ubuntu", image, pinnedReference: entry.feature ?? image,
    runtimeVersion: entry.version, languages: [...entry.languages], runnerCompatible: true,
  }));
}

export function environmentTemplateConfiguration(name: string): Record<string, unknown> {
  const definition = definitions.find((entry) => entry.name === name);
  if (!definition) throw new Error(`Unknown environment template: ${name}`);
  return {
    name: `Clanky ${definition.name}`, image, remoteUser: "vscode",
    features: definition.feature ? { [definition.feature]: {} } : {},
  };
}
