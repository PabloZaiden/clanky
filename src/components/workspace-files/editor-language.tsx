const EDITOR_LANGUAGE_OPTIONS = [
  { id: "plaintext", label: "Plain Text" },
  { id: "typescript", label: "TypeScript" },
  { id: "javascript", label: "JavaScript" },
  { id: "python", label: "Python" },
  { id: "csharp", label: "C#" },
  { id: "rust", label: "Rust" },
  { id: "json", label: "JSON" },
  { id: "markdown", label: "Markdown" },
  { id: "css", label: "CSS" },
  { id: "html", label: "HTML" },
  { id: "shell", label: "Shell" },
  { id: "yaml", label: "YAML" },
] as const;

export type EditorLanguageId = (typeof EDITOR_LANGUAGE_OPTIONS)[number]["id"];
export type EditorLanguageSelection = "auto" | EditorLanguageId;

export function detectEditorLanguage(path: string | undefined): EditorLanguageId {
  if (!path) return "plaintext";
  const normalizedPath = path.toLowerCase();
  if (normalizedPath.endsWith(".ts") || normalizedPath.endsWith(".tsx")) return "typescript";
  if (normalizedPath.endsWith(".js") || normalizedPath.endsWith(".jsx")) return "javascript";
  if (
    normalizedPath.endsWith(".py")
    || normalizedPath.endsWith(".py2")
    || normalizedPath.endsWith(".py3")
    || normalizedPath.endsWith(".pyw")
    || normalizedPath.endsWith(".pyi")
    || normalizedPath.endsWith(".pyx")
    || normalizedPath.endsWith(".pxd")
    || normalizedPath.endsWith(".pxi")
  ) return "python";
  if (normalizedPath.endsWith(".cs")) return "csharp";
  if (normalizedPath.endsWith(".rs")) return "rust";
  if (normalizedPath.endsWith(".json")) return "json";
  if (normalizedPath.endsWith(".md") || normalizedPath.endsWith(".markdown")) return "markdown";
  if (normalizedPath.endsWith(".css")) return "css";
  if (normalizedPath.endsWith(".html")) return "html";
  if (normalizedPath.endsWith(".sh")) return "shell";
  if (normalizedPath.endsWith(".yml") || normalizedPath.endsWith(".yaml")) return "yaml";
  return "plaintext";
}

export function getEditorLanguageLabel(languageId: EditorLanguageId): string {
  return EDITOR_LANGUAGE_OPTIONS.find((language) => language.id === languageId)?.label ?? "Plain Text";
}

export function EditorLanguageOptions({ detectedLanguage }: { detectedLanguage: EditorLanguageId }) {
  return (
    <>
      <option value="auto">Auto ({getEditorLanguageLabel(detectedLanguage)})</option>
      {EDITOR_LANGUAGE_OPTIONS.map((language) => (
        <option key={language.id} value={language.id}>{language.label}</option>
      ))}
    </>
  );
}
