import MonacoEditor from "@monaco-editor/react";
import { useTheme } from "@pablozaiden/webapp/web";

export function MonacoCodeEditor({
  value,
  language,
  height,
  wordWrap = "on",
  onChange,
}: {
  value: string;
  language: string;
  height: string;
  wordWrap?: "on" | "off";
  onChange: (value: string) => void;
}) {
  const { resolvedTheme } = useTheme();
  return (
    <MonacoEditor
      height={height}
      theme={resolvedTheme === "dark" ? "vs-dark" : "vs"}
      language={language}
      value={value}
      onChange={(nextValue: string | undefined) => onChange(nextValue ?? "")}
      options={{
        minimap: { enabled: false },
        fontSize: 14,
        automaticLayout: true,
        wordWrap,
        scrollBeyondLastLine: false,
      }}
    />
  );
}
