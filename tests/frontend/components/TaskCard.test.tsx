/**
 * Tests for the TaskCard component.
 */

import { test, expect, describe, mock } from "bun:test";
import { TaskCard } from "@/components/TaskCard";
import { renderWithUser } from "../helpers/render";
import { createTask } from "../helpers/factories";

describe("TaskCard", () => {
  describe("card click", () => {
    test("clicking card invokes onClick handler", async () => {
      const task = createTask({ config: { name: "Clickable Task" } });
      const onClick = mock();
      const { getByText, user } = renderWithUser(
        <TaskCard task={task} onClick={onClick} />
      );
      await user.click(getByText("Clickable Task"));
      expect(onClick).toHaveBeenCalledTimes(1);
    });
  });
});
