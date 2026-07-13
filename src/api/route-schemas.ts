import { z } from "zod";

export const SensitiveQuerySchema = z.object({
  sensitive: z.enum(["true", "false"]).optional(),
});
