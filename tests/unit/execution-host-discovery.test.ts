import { describe, expect, test } from "bun:test";
import { parseAccessibleIpv4Addresses } from "../../src/core/execution-host-discovery-service";

describe("Execution host address discovery", () => {
  test("keeps Docker bridge addresses available for published container ports", () => {
    const output = [
      "1: lo    inet 127.0.0.1/8 scope host lo",
      "2: eth0  inet 192.0.2.10/24 scope global eth0",
      "3: docker0 inet 172.18.0.1/16 scope global docker0",
      "4: veth1234@if5 inet 172.18.0.2/16 scope global veth1234",
      "5: eth0  inet 169.254.1.10/16 scope link eth0",
    ].join("\n");

    expect(parseAccessibleIpv4Addresses(output)).toEqual([
      "172.18.0.1",
      "192.0.2.10",
    ]);
  });
});
