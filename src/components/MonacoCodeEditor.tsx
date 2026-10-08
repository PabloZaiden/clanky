import MonacoEditor from "@monaco-editor/react";
import { useTheme } from "@pablozaiden/webapp/web";
import { useEffect, useRef } from "react";
import {
  CLANKY_PYTHON_LANGUAGE_ID,
  configureClankyPython,
} from "./python-monaco-language";

export function MonacoCodeEditor({
  value,
  language,
  height,
  wordWrap = "on",
  readOnly = false,
  ariaLabel = "Code editor",
  onChange,
  onSaveShortcut,
}: {
  value: string;
  language: string;
  height: string;
  wordWrap?: "on" | "off";
  readOnly?: boolean;
  ariaLabel?: string;
  onChange: (value: string) => void;
  onSaveShortcut?: () => void;
}) {
  const { resolvedTheme } = useTheme();
  const onSaveShortcutRef = useRef(onSaveShortcut);

  useEffect(() => {
    onSaveShortcutRef.current = onSaveShortcut;
  }, [onSaveShortcut]);

  return (
    <MonacoEditor
      height={height}
      theme={resolvedTheme === "dark" ? "vs-dark" : "vs"}
      language={language === "python" ? CLANKY_PYTHON_LANGUAGE_ID : language}
      beforeMount={configureClankyPython}
      onMount={(editor, monaco) => {
        if (onSaveShortcut) {
          editor.addCommand(
            monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS,
            () => onSaveShortcutRef.current?.(),
          );
        }
      }}
      value={value}
      onChange={(nextValue: string | undefined) => onChange(nextValue ?? "")}
      options={{
        minimap: { enabled: false },
        fontSize: 14,
        automaticLayout: true,
        wordWrap,
        readOnly,
        scrollBeyondLastLine: false,
        ariaLabel,
      }}
    />
  );
}
