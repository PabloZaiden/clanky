import { z } from "zod";

export const CONTROL_IMAGE_RESULT_MAX_BYTES = 900_000;
export const CONTROL_IMAGE_MAX_BYTES = 600_000;
const ControlImageResultSchema = z.object({
  kind: z.literal("clanky_image_result"),
  result: z.record(z.string(), z.unknown()),
  images: z.array(z.object({
    mimeType: z.literal("image/png"),
    data: z.string().min(1).max(CONTROL_IMAGE_MAX_BYTES),
  }).strict()).length(1),
}).strict();

export type ControlImageResult = z.infer<typeof ControlImageResultSchema>;

export function readControlImageResult(value: unknown): ControlImageResult | undefined {
  const parsed = ControlImageResultSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export function controlResultContent(value: unknown) {
  const image = readControlImageResult(value);
  return [
    { type: "text" as const, text: JSON.stringify(image?.result ?? value) },
    ...(image?.images.map((item) => ({ type: "image" as const, ...item })) ?? []),
  ];
}
