import { z } from "zod";

export const CheckExecutionHostPrerequisitesRequestSchema = z.object({}).strict();
export const GetEnvironmentTemplatesRequestSchema = z.object({}).strict();

export type CheckExecutionHostPrerequisitesRequest =
  z.infer<typeof CheckExecutionHostPrerequisitesRequestSchema>;
export type GetEnvironmentTemplatesRequest =
  z.infer<typeof GetEnvironmentTemplatesRequestSchema>;
