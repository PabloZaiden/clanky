/**
 * Tests for the LoopCard component.
 */

import { test, expect, describe, mock } from "bun:test";
import { LoopCard } from "@/components/LoopCard";
import { renderWithUser } from "../helpers/render";
import { createLoop } from "../helpers/factories";

describe("LoopCard", () => {
  describe("rename button", () => {
    test("rename button calls onRename", async () => {
      const loop = createLoop();
      const onRename = mock();
      const { getByLabelText, user } = renderWithUser(
        <LoopCard loop={loop} onRename={onRename} />
      );
      await user.click(getByLabelText("Rename loop"));
      expect(onRename).toHaveBeenCalled();
    });
  });

  describe("card click", () => {
    test("clicking card invokes onClick handler", async () => {
      const loop = createLoop({ config: { name: "Clickable Loop" } });
      const onClick = mock();
      const { getByText, user } = renderWithUser(
        <LoopCard loop={loop} onClick={onClick} />
      );
      await user.click(getByText("Clickable Loop"));
      expect(onClick).toHaveBeenCalledTimes(1);
    });
  });
});
