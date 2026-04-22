import { describe, expect, test } from "bun:test";
import { CodeExplorerView } from "@/components/app-shell/code-explorer-view";
import { renderWithUser, waitFor } from "../helpers/render";
import { createLoopWithStatus, createWorkspace } from "../helpers/factories";

describe("CodeExplorerView", () => {
  test("switches content from the generic header dropdown", async () => {
    const workspace = createWorkspace({
      id: "workspace-picker",
      name: "Picker Workspace",
      directory: "/workspaces/picker",
    });
    const loop = createLoopWithStatus("idle", {
      config: {
        id: "picker-loop",
        name: "Picker Loop",
        workspaceId: workspace.id,
        directory: workspace.directory,
      },
    });
    const navigations: unknown[] = [];

    const { getByLabelText, getByRole, user } = renderWithUser(
      <CodeExplorerView
        loops={[loop]}
        chats={[]}
        workspaces={[workspace]}
        sessions={[]}
        servers={[]}
        sessionsByServerId={{}}
        createSession={async () => {
          throw new Error("not used");
        }}
        createStandaloneSession={async () => {
          throw new Error("not used");
        }}
        onNavigate={(route) => {
          navigations.push(route);
        }}
      />,
    );

    await waitFor(() => {
      expect(getByRole("heading", { name: "Code explorer" })).toBeInTheDocument();
    });

    await user.selectOptions(getByLabelText("Select code explorer content"), "loop:picker-loop");

    expect(navigations).toEqual([{
      view: "code-explorer",
      target: {
        contentType: "loop",
        loopId: "picker-loop",
      },
    }]);
  });
});
