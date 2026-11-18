import { generate, parse } from "css-tree";
import { THEME_STYLE_TOKENS, themeStyleSchema, type ThemeStyle, type ThemeStyleTokens } from "@pablozaiden/webapp/contracts";
import { CustomThemeSchema, THEME_FILE_MAX_BYTES, type CustomTheme } from "@/contracts/schemas/appearance";
import type { AppearanceTheme } from "./appearance-themes";

export async function readThemeFile(file: File): Promise<CustomTheme> {
  if (!file.size || file.size > THEME_FILE_MAX_BYTES) {
    throw new Error("Choose a .clanky-theme.css file no larger than 64 KiB.");
  }
  const source = await file.text();
  const stylesheet = parse(source, {
    parseCustomProperty: true,
    onParseError(error) { throw new Error(`Invalid theme stylesheet: ${error.message}`); },
  });
  if (stylesheet.type !== "StyleSheet") throw new Error("Invalid theme stylesheet.");
  const palettes = new Map<string, ThemeStyleTokens>();
  stylesheet.children.forEach((rule) => {
    if (rule.type !== "Rule" || !rule.prelude) {
      throw new Error("Themes may contain only :root and :root.dark token declarations. Imports and other rules are not supported.");
    }
    const selector = generate(rule.prelude);
    if (selector !== ":root" && selector !== ":root.dark") {
      throw new Error("Use :root for light colors and :root.dark for dark colors.");
    }
    if (palettes.has(selector)) throw new Error(`The theme contains more than one ${selector} block.`);
    const tokens: ThemeStyleTokens = {};
    rule.block.children.forEach((declaration) => {
      if (declaration.type !== "Declaration" || declaration.important) {
        throw new Error("Themes support only token declarations, without !important.");
      }
      const name = THEME_STYLE_TOKENS.find((token) => token === declaration.property);
      if (!name) throw new Error(`Unsupported theme token: ${declaration.property}`);
      if (Object.hasOwn(tokens, name)) throw new Error(`Duplicate theme token: ${name}`);
      tokens[name] = generate(declaration.value).trim();
    });
    palettes.set(selector, tokens);
  });
  const light = palettes.get(":root");
  const dark = palettes.get(":root.dark");
  if (!light || !dark) throw new Error("Include both :root and :root.dark blocks in the theme.");
  const name = source.match(/\/\*\s*Clanky theme:\s*([^\r\n]*?)\s*\*\//i)?.[1]
    ?? file.name.replace(/(?:\.clanky-theme)?\.css$/i, "");
  const result = CustomThemeSchema.safeParse({
    id: crypto.randomUUID(), name, style: { light, dark },
  });
  if (!result.success) throw new Error(result.error.issues.map((issue) => issue.message).join(" "));
  return result.data;
}

export function themeFileContents(theme: AppearanceTheme): string {
  const style: ThemeStyle = themeStyleSchema.parse(theme.style ?? { light: {}, dark: {} });
  const block = (selector: string, tokens: ThemeStyleTokens) =>
    `${selector} {\n${Object.entries(tokens).map(([name, value]) => `  ${name}: ${value};`).join("\n")}\n}`;
  return `/* Clanky theme: ${theme.name} */\n\n${block(":root", style.light)}\n\n${block(":root.dark", style.dark)}\n`;
}
