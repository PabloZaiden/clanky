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
    input: `cmd /Q /V:ON /C "set "_clanky_rows=" & set "_clanky_size_done=" & for /f "skip=2 tokens=2 delims=: " %A in ('mode con') do @if not defined _clanky_rows (set "_clanky_rows=%A") else if not defined _clanky_size_done (echo ${options.marker}:!_clanky_rows! %A:DONE&set "_clanky_size_done=1")"\r\n`,
    expectedOutput: `${options.marker}:${String(options.rows)} ${String(options.cols)}:DONE`,
  };
}

export function buildTerminalLiteralProbe(options: {
  marker: string;
  os: "linux" | "darwin" | "windows";
}): {
  input: string;
  expectedOutput: string;
} {
  const expectedOutput = `${options.marker}:literal!value:DONE`;
  if (options.os !== "windows") {
    return {
      input: `printf '%s\\n' '${expectedOutput}'\n`,
      expectedOutput,
    };
  }
  return resolveWindowsTerminalShell().kind === "powershell"
    ? {
        input: `Write-Output '${expectedOutput}'\r\n`,
        expectedOutput,
      }
    : {
        input: `echo ${expectedOutput}\r\n`,
        expectedOutput,
      };
}

export function buildTerminalCwdProbe(options: {
  marker: string;
  os: "linux" | "darwin" | "windows";
}): string {
  if (options.os !== "windows") {
    return `printf '${options.marker}:%s:DONE\\n' "$PWD"\n`;
  }
  return resolveWindowsTerminalShell().kind === "powershell"
    ? `$cwd=(Get-Location).Path; Write-Output "${options.marker}:$($cwd):DONE"\r\n`
    : `echo ${options.marker}:%CD%:DONE\r\n`;
}
