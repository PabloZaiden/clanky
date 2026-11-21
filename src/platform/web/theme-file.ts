import { generate, parse, tokenize, tokenTypes } from "css-tree";
import { THEME_STYLE_TOKENS, themeStyleSchema, type ThemeStyle, type ThemeStyleTokens } from "@pablozaiden/webapp/contracts";
import type { AppearanceTheme } from "./appearance-themes";

const themeNameComment = /^Clanky (CSS )?theme:/i;

function inspectThemeSource(css: string) {
  let name: string | undefined;
  let standardCss = false;
  let blocks = 0;
  let nestedSyntax = false;
  tokenize(css, (type, start, end) => {
    if (type === tokenTypes.LeftCurlyBracket) blocks++;
    if (type === tokenTypes.Function || type === tokenTypes.LeftParenthesis || type === tokenTypes.LeftSquareBracket) {
      nestedSyntax = true;
    }
    if (type !== tokenTypes.Comment || standardCss || css.slice(end - 2, end) !== "*/") return;
    const comment = css.slice(start + 2, end - 2).trim();
    const match = themeNameComment.exec(comment);
    if (!match) return;
    const title = comment.slice(match[0].length).trim();
    if (/[\r\n]/.test(title)) return;
    standardCss = Boolean(match[1]);
    if (name === undefined || standardCss) name = title;
  });
  return { name, possibleLegacy: !standardCss && blocks === 2 && !nestedSyntax };
}

function readLegacyPalette(css: string): ThemeStyle | undefined {
  let parseError = false;
  const stylesheet = parse(css, {
    parseCustomProperty: true,
    onParseError() { parseError = true; },
  });
  if (parseError || stylesheet.type !== "StyleSheet") return;
  const palettes = new Map<string, ThemeStyleTokens>();
  for (const rule of stylesheet.children) {
    if (rule.type !== "Rule" || !rule.prelude) return;
    const selector = generate(rule.prelude);
    if ((selector !== ":root" && selector !== ":root.dark") || palettes.has(selector)) return;
    const tokens: ThemeStyleTokens = {};
    for (const declaration of rule.block.children) {
      if (declaration.type !== "Declaration" || declaration.important) return;
      const name = THEME_STYLE_TOKENS.find(token => token === declaration.property);
      if (!name || Object.hasOwn(tokens, name)) return;
      tokens[name] = generate(declaration.value).trim();
    }
    palettes.set(selector, tokens);
  }
  const style = themeStyleSchema.safeParse({ light: palettes.get(":root"), dark: palettes.get(":root.dark") });
  return style.success ? style.data : undefined;
}

function paletteContents(style: ThemeStyle, lightSelector: string): string {
  const block = (selector: string, tokens: ThemeStyleTokens) =>
    `${selector} {\n${Object.entries(tokens).map(([name, value]) => `  ${name}: ${value};`).join("\n")}\n}`;
  return `${block(lightSelector, style.light)}\n\n${block(":root.dark", style.dark)}\n`;
}

export async function readThemeCss(file: File): Promise<string> {
  const css = await file.text();
  const { possibleLegacy } = inspectThemeSource(css);
  // Only past palette files need parsing; every other stylesheet goes straight to the browser.
  const style = possibleLegacy ? readLegacyPalette(css) : undefined;
  return style ? paletteContents(style, ":root:not(.dark)") : css;
}

export function editableThemeCss(theme: AppearanceTheme): string {
  return theme.css ?? (theme.style ? paletteContents(theme.style, ":root:not(.dark)") : "");
}

export function themeFileContents(theme: AppearanceTheme): string {
  if (theme.css !== undefined) {
    return inspectThemeSource(theme.css).name !== undefined ? theme.css : `/* Clanky CSS theme: ${theme.name} */\n\n${theme.css}`;
  }
  const style: ThemeStyle = themeStyleSchema.parse(theme.style ?? { light: {}, dark: {} });
  return `/* Clanky theme: ${theme.name} */\n\n${paletteContents(style, ":root")}`;
}
