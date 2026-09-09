import { describe, expect, test } from "bun:test";
import {
  getSinglePublishedPort,
  parseDevboxStatusOutput,
} from "../../src/core/provisioning/devbox-utils";
import { createDevboxStatusOutput } from "../mocks/provisioning-test-executor";

describe("Devbox worker port discovery", () => {
  test("requires a TCP publication and ignores UDP-only mappings", () => {
    const udpOnly = parseDevboxStatusOutput(createDevboxStatusOutput({
      publishedPorts: {
        "5001/udp": [{ hostIp: "0.0.0.0", hostPort: 5001 }],
      },
    }));
    expect(() => getSinglePublishedPort(udpOnly)).toThrow(
      "Devbox must publish exactly one port for worker provisioning.",
    );

    const tcp = parseDevboxStatusOutput(createDevboxStatusOutput({
      publishedPorts: {
        "5001/tcp": [{ hostIp: "0.0.0.0", hostPort: 5001 }],
        "5001/udp": [{ hostIp: "0.0.0.0", hostPort: 5001 }],
      },
    }));
    expect(getSinglePublishedPort(tcp)).toEqual({
      containerPort: 5001,
      hostPort: 5001,
    });
  });
});
