import type {
  DeterministicAgentContext,
  DeterministicCodeDiagnostic,
} from "@/shared/deterministic-agent";

const DEFAULT_EXPORT_PATTERN = /export\s+default\s+(?:async\s+)?function(?:\s+[A-Za-z_$][\w$]*)?\s*\(/;

function diagnosticFromError(error: unknown): DeterministicCodeDiagnostic {
  const message = String(error);
  const location = message.match(/line\s+(\d+)(?:[:,]\s*(\d+))?/i);
  return {
    message,
    ...(location?.[1] ? { line: Number(location[1]) } : {}),
    ...(location?.[2] ? { column: Number(location[2]) } : {}),
  };
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
  try {
    const transpiler = new Bun.Transpiler({ loader: "ts" });
    transpiler.transformSync(normalized);
  } catch (error) {
    diagnostics.push(diagnosticFromError(error));
  }

  if (!DEFAULT_EXPORT_PATTERN.test(normalized)) {
    diagnostics.push({
      message: "Code must export a default function with signature run(ctx).",
    });
  }

  return diagnostics;
}

export async function loadDeterministicAgentProgram(
  code: string,
): Promise<(context: DeterministicAgentContext) => Promise<unknown> | unknown> {
  const diagnostics = validateDeterministicAgentCode(code);
  if (diagnostics.length > 0) {
    throw new Error(diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
  }

  const transpiler = new Bun.Transpiler({ loader: "ts" });
  const javascript = transpiler.transformSync(code);
  const moduleUrl = URL.createObjectURL(new Blob([javascript], { type: "text/javascript" }));
  try {
    const module = await import(moduleUrl);
    if (typeof module.default !== "function") {
      throw new Error("Deterministic agent code must export a callable default function.");
    }
    return module.default as (context: DeterministicAgentContext) => Promise<unknown> | unknown;
  } finally {
    URL.revokeObjectURL(moduleUrl);
  }
}
