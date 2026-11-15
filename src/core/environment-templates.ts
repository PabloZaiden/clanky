import { z } from "zod";
import type { EnvironmentTemplateSummary } from "@/shared";

const EnvironmentTemplateSummarySchema = z.object({
  name: z.string().trim().min(1, "template name is required"),
  description: z.string(),
  source: z.literal("built-in"),
  base: z.string().trim().min(1, "template base is required"),
  image: z.string().trim().min(1).nullable(),
  pinnedReference: z.string().trim().min(1, "template pinned reference is required"),
  runtimeVersion: z.string().trim().min(1, "template runtime version is required"),
  languages: z.array(z.string().trim()),
  runnerCompatible: z.boolean(),
});

const EnvironmentTemplateSummariesSchema = z.array(EnvironmentTemplateSummarySchema);

export function parseEnvironmentTemplatesOutput(stdout: string): EnvironmentTemplateSummary[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    throw new Error("Failed to parse environment templates output as JSON", { cause: error });
  }

  const result = EnvironmentTemplateSummariesSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`Failed to validate environment templates output: ${result.error.issues[0]?.message ?? "invalid format"}`);
  }

  return result.data.map((template) => ({
    ...template,
    languages: [...template.languages],
  }));
}
