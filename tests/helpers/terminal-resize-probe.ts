import { resolveWindowsTerminalShell } from "../../src/core/terminal/local-terminal-runtime";

export function buildTerminalResizeProbe(options: {
  marker: string;
  os: "linux" | "darwin" | "windows";
  cols: number;
  rows: number;
}): {
  input: string;
  expectedOutput: string;
} {
  if (options.os !== "windows") {
    return {
      input: `size=$(stty size); printf '${options.marker}:%s:DONE\\n' "$size"\n`,
      expectedOutput: `${options.marker}:${String(options.rows)} ${String(options.cols)}:DONE`,
    };
  }
  if (resolveWindowsTerminalShell().kind === "powershell") {
    return {
      input: `$size=$Host.UI.RawUI.WindowSize; Write-Output "${options.marker}:$($size.Height) $($size.Width):DONE"\r\n`,
      expectedOutput: `${options.marker}:${String(options.rows)} ${String(options.cols)}:DONE`,
    };
  }
  return {
    input: `echo ${options.marker}:CMD:DONE\r\n`,
    expectedOutput: `${options.marker}:CMD:DONE`,
  };
}
