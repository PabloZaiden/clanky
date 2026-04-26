const frontendEntryPattern = /(^[ \t]*)<script\s+type="module"\s+src="\.\/frontend\.tsx"><\/script>/m;

export function rewriteBuiltIndexHtml(
  sourceHtml: string,
  options: {
    entryScriptFileName: string;
    stylesheetFileName?: string;
  },
): string {
  const match = sourceHtml.match(frontendEntryPattern);
  if (!match) {
    throw new Error(
      "Web build could not replace the frontend entry script in apps/web/src/index.html.",
    );
  }

  const indentation = match[1] ?? "";
  const stylesheetTag = options.stylesheetFileName
    ? `${indentation}<link rel="stylesheet" href="./${options.stylesheetFileName}" />\n`
    : "";
  const entryScriptTag = `${indentation}<script type="module" src="./${options.entryScriptFileName}"></script>`;
  const rewrittenHtml = sourceHtml.replace(
    frontendEntryPattern,
    `${stylesheetTag}${entryScriptTag}`,
  );

  if (rewrittenHtml.includes('src="./frontend.tsx"')) {
    throw new Error("Web build left a stale ./frontend.tsx script reference in dist/index.html.");
  }

  return rewrittenHtml;
}
