import { z } from "zod";
import { themeStyleSchema } from "@pablozaiden/webapp/contracts";

export const BUILT_IN_THEME_IDS = ["clanky", "graphite", "nord", "sand", "forest", "plum"] as const;
export const CUSTOM_THEME_ID = "custom";
export const SAFE_THEME_PARAMETER = "safe-theme";
const themeIdentity = z.strictObject({
  id: z.uuid(),
  name: z.string().trim().min(1).max(60).refine(
    (name) => !/[\u0000-\u001f\u007f*]/.test(name),
    "Theme names cannot contain control characters or asterisks.",
  ),
});
export const CustomThemeSchema = z.union([
  themeIdentity.extend({ css: z.string() }),
  themeIdentity.extend({ style: themeStyleSchema }),
]);
export const AppearancePreferenceSchema = z.object({
  selected: z.union([z.enum(BUILT_IN_THEME_IDS), z.literal(CUSTOM_THEME_ID), z.uuid()]),
  customThemes: z.array(CustomThemeSchema).max(20, "Keep at most 20 custom themes."),
  customCss: z.string().optional(),
}).strict().superRefine((value, context) => {
  const ids = new Set<string>();
  for (const [index, theme] of value.customThemes.entries()) {
    if (ids.has(theme.id)) context.addIssue({ code: "custom", path: ["customThemes", index, "id"], message: "Theme IDs must be unique." });
    ids.add(theme.id);
  }
  if (value.selected !== CUSTOM_THEME_ID && !BUILT_IN_THEME_IDS.some((id) => id === value.selected) && !ids.has(value.selected)) {
    context.addIssue({ code: "custom", path: ["selected"], message: "Choose an available theme." });
  }
});
export type CustomTheme = z.infer<typeof CustomThemeSchema>;
export type AppearancePreference = z.infer<typeof AppearancePreferenceSchema>;
export const DEFAULT_APPEARANCE: AppearancePreference = { selected: "clanky", customThemes: [] };
