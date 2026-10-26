import { createContext, useContext } from "react";

export const WorkspaceReadOnlyContext = createContext(false);

export function useWorkspaceReadOnly(): boolean {
  return useContext(WorkspaceReadOnlyContext);
}
