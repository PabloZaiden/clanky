import MonacoEditor from "@monaco-editor/react";
import { useTheme } from "@pablozaiden/webapp/web";
import {
  CLANKY_PYTHON_LANGUAGE_ID,
  configureClankyPython,
} from "./python-monaco-language";

export function MonacoCodeEditor({
  value,
  language,
  height,
  wordWrap = "on",
  ariaLabel = "Code editor",
  onChange,
}: {
  value: string;
  language: string;
  height: string;
  wordWrap?: "on" | "off";
  ariaLabel?: string;
  onChange: (value: string) => void;
}) {
  const { resolvedTheme } = useTheme();
  return (
    <MonacoEditor
      height={height}
      theme={resolvedTheme === "dark" ? "vs-dark" : "vs"}
      language={language === "python" ? CLANKY_PYTHON_LANGUAGE_ID : language}
      beforeMount={configureClankyPython}
      value={value}
      onChange={(nextValue: string | undefined) => onChange(nextValue ?? "")}
      options={{
        minimap: { enabled: false },
        fontSize: 14,
        automaticLayout: true,
        wordWrap,
        scrollBeyondLastLine: false,
        ariaLabel,
      }}
    />
  );
}
