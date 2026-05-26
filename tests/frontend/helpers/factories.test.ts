import { describe, expect, test } from "bun:test";
import { createChat } from "./factories";

describe("frontend test factories", () => {
  test("createChat derives config and state IDs from one computed ID", () => {
    const chat = createChat({
      config: { id: "config-id" },
      state: { id: "state-id" },
    });

    expect(chat.config.id).toBe("config-id");
    expect(chat.state.id).toBe("config-id");
  });
});
