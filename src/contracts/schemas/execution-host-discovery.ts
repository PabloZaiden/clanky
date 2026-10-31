import { z } from "zod";

export const CheckExecutionHostPrerequisitesRequestSchema = z.object({}).strict();
export const GetDevboxTemplatesRequestSchema = z.object({}).strict();

export type CheckExecutionHostPrerequisitesRequest =
  z.infer<typeof CheckExecutionHostPrerequisitesRequestSchema>;
export type GetDevboxTemplatesRequest =
  z.infer<typeof GetDevboxTemplatesRequestSchema>;
