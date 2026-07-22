import type { DeterministicCodeDiagnostic } from "@/shared/deterministic-agent";

const DEFAULT_EXPORT_PATTERN = /^\s*export\s+default\s+(?:async\s+)?function(?:\s+[A-Za-z_$][\w$]*)?\s*\(/m;
const NODE_STRIP_ONLY_UNSUPPORTED_PATTERNS = [
  {
    pattern: /\b(?:const\s+|declare\s+)?enum\s+[A-Za-z_$][\w$]*/,
    message: "Node.js type stripping does not support enum declarations; use string or object constants instead.",
  },
  {
    pattern: /\bnamespace\s+[A-Za-z_$][\w$]*\s*\{/,
    message: "Node.js type stripping does not support namespace declarations; use ordinary modules instead.",
  },
  {
    pattern: /\bmodule\s+(?:[A-Za-z_$][\w$]*\s*)?\{/,
    message: "Node.js type stripping does not support module declarations; use ordinary modules instead.",
  },
] as const;

function diagnosticFromError(error: unknown): DeterministicCodeDiagnostic {
  const message = String(error);
  const location = message.match(/line\s+(\d+)(?:[:,]\s*(\d+))?/i);
  return {
    message,
    ...(location?.[1] ? { line: Number(location[1]) } : {}),
    ...(location?.[2] ? { column: Number(location[2]) } : {}),
  };
}

function maskCommentsAndStrings(source: string): string {
  const characters = source.split("");
  let state: "code" | "line-comment" | "block-comment" | "single-quote" | "double-quote" | "template" = "code";
  let escaped = false;

  for (let index = 0; index < characters.length; index += 1) {
    const character = characters[index];
    const nextCharacter = characters[index + 1];

    if (state === "line-comment") {
      if (character === "\n") {
        state = "code";
      } else {
        characters[index] = " ";
      }
      continue;
    }

    if (state === "block-comment") {
      if (character === "*" && nextCharacter === "/") {
        characters[index] = " ";
        characters[index + 1] = " ";
        index += 1;
        state = "code";
      } else if (character !== "\n") {
        characters[index] = " ";
      }
      continue;
    }

    if (state === "single-quote" || state === "double-quote" || state === "template") {
      if (escaped) {
        escaped = false;
        if (character !== "\n") {
          characters[index] = " ";
        }
        continue;
      }
      if (character === "\\") {
        escaped = true;
        characters[index] = " ";
        continue;
      }
      const closingQuote = state === "single-quote"
        ? "'"
        : state === "double-quote"
          ? "\""
          : "`";
      if (character === closingQuote) {
        characters[index] = " ";
        state = "code";
      } else if (character !== "\n") {
        characters[index] = " ";
      }
      continue;
    }

    if (character === "/" && nextCharacter === "/") {
      characters[index] = " ";
      characters[index + 1] = " ";
      index += 1;
      state = "line-comment";
      continue;
    }
    if (character === "/" && nextCharacter === "*") {
      characters[index] = " ";
      characters[index + 1] = " ";
      index += 1;
      state = "block-comment";
      continue;
    }
    if (character === "'") {
      characters[index] = " ";
      state = "single-quote";
      continue;
    }
    if (character === "\"") {
      characters[index] = " ";
      state = "double-quote";
      continue;
    }
    if (character === "`") {
      characters[index] = " ";
      state = "template";
    }
  }

  return characters.join("");
}

function maskRegexLiterals(source: string): string {
  return source.replace(/\/(?![/*])(?:\\.|[^/\\\n])*\/[a-z]*/gi, (match) =>
    match.replace(/[^\n]/g, " "),
  );
}

function getLineAndColumn(source: string, offset: number): { line: number; column: number } {
  const prefix = source.slice(0, offset);
  const line = prefix.split("\n").length;
  const lastNewline = prefix.lastIndexOf("\n");
  return {
    line,
    column: offset - lastNewline,
  };
}

function findParameterPropertyOffset(maskedSource: string): number | undefined {
  const constructorPattern = /\bconstructor\s*\(/g;
  let constructorMatch: RegExpExecArray | null;
  while ((constructorMatch = constructorPattern.exec(maskedSource)) !== null) {
    const openingOffset = maskedSource.indexOf("(", constructorMatch.index);
    let depth = 0;
    for (let index = openingOffset; index < maskedSource.length; index += 1) {
      const character = maskedSource[index];
      if (character === "(") {
        depth += 1;
      } else if (character === ")") {
        depth -= 1;
        if (depth === 0) {
          const parameters = maskedSource.slice(openingOffset + 1, index);
          let parameterStart = 0;
          let parameterDepth = 0;
          for (let parameterIndex = 0; parameterIndex <= parameters.length; parameterIndex += 1) {
            const parameterCharacter = parameters[parameterIndex];
            if (parameterCharacter === "(" || parameterCharacter === "[" || parameterCharacter === "{") {
              parameterDepth += 1;
            } else if (parameterCharacter === ")" || parameterCharacter === "]" || parameterCharacter === "}") {
              parameterDepth = Math.max(0, parameterDepth - 1);
            }
            if ((parameterCharacter === "," && parameterDepth === 0) || parameterIndex === parameters.length) {
              const parameter = parameters.slice(parameterStart, parameterIndex).trim();
              if (/^(?:(?:public|private|protected|readonly)\s+)+/.test(parameter)) {
                return openingOffset + 1 + parameterStart + parameters.slice(parameterStart, parameterIndex).search(/\S/);
              }
              parameterStart = parameterIndex + 1;
            }
          }
          break;
        }
      }
    }
  }
  return undefined;
}

function nodeRuntimeDiagnostics(source: string): DeterministicCodeDiagnostic[] {
  const maskedSource = maskRegexLiterals(maskCommentsAndStrings(source));
  const diagnostics: DeterministicCodeDiagnostic[] = [];

  for (const unsupported of NODE_STRIP_ONLY_UNSUPPORTED_PATTERNS) {
    const match = unsupported.pattern.exec(maskedSource);
    if (!match) {
      continue;
    }
    const location = getLineAndColumn(source, match.index);
    diagnostics.push({
      message: unsupported.message,
      ...location,
    });
  }

  const parameterPropertyOffset = findParameterPropertyOffset(maskedSource);
  if (parameterPropertyOffset !== undefined) {
    diagnostics.push({
      message: "Node.js type stripping does not support constructor parameter properties; assign the value inside the constructor instead.",
      ...getLineAndColumn(source, parameterPropertyOffset),
    });
  }

  return diagnostics;
}

export function normalizeAgentCode(code: string | null | undefined): string | undefined {
  if (typeof code !== "string" || code.trim().length === 0) {
    return undefined;
  }
  return code;
}

export function validateDeterministicAgentCode(code: string): DeterministicCodeDiagnostic[] {
  const normalized = normalizeAgentCode(code);
  if (!normalized) {
    return [];
  }

  const diagnostics: DeterministicCodeDiagnostic[] = [];
  let transpiled = "";
  try {
    const transpiler = new Bun.Transpiler({ loader: "ts" });
    transpiled = transpiler.transformSync(normalized);
  } catch (error) {
    diagnostics.push(diagnosticFromError(error));
  }

  if (transpiled && !DEFAULT_EXPORT_PATTERN.test(maskCommentsAndStrings(transpiled))) {
    diagnostics.push({
      message: "Code must export a default function with signature run(ctx).",
    });
  }

  if (transpiled) {
    diagnostics.push(...nodeRuntimeDiagnostics(normalized));
  }

  return diagnostics;
}
