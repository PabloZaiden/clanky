import { useMemo } from "react";
import { replaceWebAppRoute, routeToHash } from "@pablozaiden/webapp/web";
import type { Task } from "@/shared";
import { appAbsoluteUrl } from "../../lib/public-path";
import type { TranscriptFileLinkContext, TranscriptFileLinkTarget } from "../log-viewer";

export function useTaskTranscriptFileLinks(taskId: string, task: Task | null, onFileOpenError: (message: string) => void) {
  const rootDirectory = task?.state.git?.worktreePath ?? task?.config.directory;
  const workspaceId = task?.config.workspaceId;
  return useMemo<TranscriptFileLinkContext | undefined>(() => {
    if (!rootDirectory || !workspaceId) return undefined;
    const route = ({ path, startDirectory, kind }: TranscriptFileLinkTarget) => ({
      view: "code-explorer", contentType: "task", taskId, startDirectory,
      filePath: kind === "directory" ? undefined : path,
    });
    return {
      fileExplorerTarget: { type: "workspace", id: workspaceId, startDirectory: rootDirectory },
      rootDirectory,
      getFileHref: (target) => appAbsoluteUrl(routeToHash(route(target))),
      openFile: (target) => replaceWebAppRoute(route(target)),
      onFileOpenError,
    };
  }, [onFileOpenError, rootDirectory, taskId, workspaceId]);
}
