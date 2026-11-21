import { themeStyleSchema, type ThemeStyle, type ThemeStyleTokens } from "@pablozaiden/webapp/contracts";
import { CustomThemeSchema, type CustomTheme } from "@/contracts/schemas/appearance";
import type { AppearanceTheme } from "./appearance-themes";

const themeNameComment = /\/\*\s*Clanky (?:CSS )?theme:\s*([^\r\n]*?)\s*\*\//i;

function readLegacyExport(css: string): ThemeStyle | undefined {
  // The old exporter used :root for light-only overrides. Recognize its format
  // so partial palettes retain that behavior without interpreting arbitrary CSS.
  const match = /^\/\* Clanky theme: [^\r\n]* \*\/\n\n:root \{\n([\s\S]*?)\n\}\n\n:root\.dark \{\n([\s\S]*?)\n\}\n?$/.exec(css.replaceAll("\r\n", "\n"));
  if (!match) return;
  function tokens(block: string): Record<string, string> | undefined {
    const values: Record<string, string> = {};
    for (const line of block ? block.split("\n") : []) {
      const entry = /^ {2}(--[\w-]+): ([^;]+);$/.exec(line);
      if (!entry) return;
      values[entry[1]!] = entry[2]!;
    }
    return values;
  }
  const style = themeStyleSchema.safeParse({ light: tokens(match[1]!), dark: tokens(match[2]!) });
  return style.success ? style.data : undefined;
}

export async function readThemeFile(file: File): Promise<CustomTheme> {
  const css = await file.text();
  const name = css.match(themeNameComment)?.[1]
    ?? file.name.replace(/(?:\.clanky-theme)?\.css$/i, "");
  const style = readLegacyExport(css);
  const result = CustomThemeSchema.safeParse({
    id: crypto.randomUUID(), name, ...(style ? { style } : { css }),
  });
  if (!result.success) throw new Error(result.error.issues.map((issue) => issue.message).join(" "));
  return result.data;
}

export function themeFileContents(theme: AppearanceTheme): string {
  if (theme.css !== undefined) {
    return themeNameComment.test(theme.css) ? theme.css : `/* Clanky CSS theme: ${theme.name} */\n\n${theme.css}`;
  }
  const style: ThemeStyle = themeStyleSchema.parse(theme.style ?? { light: {}, dark: {} });
  const block = (selector: string, tokens: ThemeStyleTokens) =>
    `${selector} {\n${Object.entries(tokens).map(([name, value]) => `  ${name}: ${value};`).join("\n")}\n}`;
  return `/* Clanky theme: ${theme.name} */\n\n${block(":root", style.light)}\n\n${block(":root.dark", style.dark)}\n`;
}
