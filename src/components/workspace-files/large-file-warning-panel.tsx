import type { WorkspaceFileEntry } from "../../types";
import { Button } from "../common";

function formatFileSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const kib = bytes / 1024;
  if (kib < 1024) {
    return `${kib.toFixed(1)} KB`;
  }
  return `${(kib / 1024).toFixed(1)} MB`;
}

interface LargeFileWarningPanelProps {
  file: WorkspaceFileEntry;
  downloading: boolean;
  opening: boolean;
  onDownload: () => Promise<void>;
  onOpenInCodeExplorer: () => Promise<void>;
}

export function LargeFileWarningPanel({
  file,
  downloading,
  opening,
  onDownload,
  onOpenInCodeExplorer,
}: LargeFileWarningPanelProps) {
  return (
    <section className="flex h-full items-center justify-center px-6 py-8">
      <div
        role="alert"
        className="max-w-xl rounded-2xl border border-amber-200 bg-amber-50 p-6 text-amber-950 shadow-sm dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-100"
      >
        <h2 className="text-base font-semibold">This is a large file</h2>
        <p className="mt-2 text-sm">
          This is a large file ({formatFileSize(file.size)}). Do you want to download it or open it with the code explorer?
        </p>
        <p className="mt-3 break-all font-mono text-xs text-amber-800 dark:text-amber-200">
          {file.path}
        </p>
        <div className="mt-5 flex flex-wrap gap-2">
          <Button
            variant="primary"
            size="sm"
            loading={downloading}
            disabled={opening}
            onClick={() => void onDownload()}
          >
            Download
          </Button>
          <Button
            variant="secondary"
            size="sm"
            loading={opening}
            disabled={downloading}
            onClick={() => void onOpenInCodeExplorer()}
          >
            Open with code explorer
          </Button>
        </div>
      </div>
    </section>
  );
}
