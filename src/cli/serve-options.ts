import type { WebAppServeOptionDefinition } from "@pablozaiden/webapp/cli";

export const CLANKY_SERVE_OPTIONS = [
  {
    name: "mesh-worker",
    type: "boolean",
    description: "Run the restricted Mesh execution worker surface.",
    defaultValue: false,
  },
  {
    name: "worker-directory",
    type: "string",
    description: "Set the worker-owned default execution directory.",
  },
  {
    name: "worker-execution-enabled",
    type: "boolean",
    description: "Allow enrolled controllers to execute on this worker.",
    defaultValue: true,
  },
] satisfies readonly WebAppServeOptionDefinition[];
