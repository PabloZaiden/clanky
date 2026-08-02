import { describe, expect, test } from "bun:test";
import { DomainError } from "../../src/core/domain-error";
import {
  assertMeshEndpointAllowed,
  getMeshTransport,
} from "../../src/core/mesh-transport-config";

describe("mesh transport configuration", () => {
  test("accepts HTTPS without a public certificate requirement", () => {
    expect(getMeshTransport("https://mesh.example.test")).toBe("https");
    expect(assertMeshEndpointAllowed("https://mesh.example.test").protocol).toBe("https:");
  });

  test("accepts loopback HTTP for local development", () => {
    expect(getMeshTransport("http://127.0.0.1:4100")).toBe("http");
    expect(getMeshTransport("http://localhost:4100")).toBe("http");
  });

  test("does not allow insecure HTTP on a LAN endpoint", () => {
    expect(() => assertMeshEndpointAllowed("http://192.168.1.20:4100")).toThrow(DomainError);
  });

  test("rejects transport declarations that do not match the URL", () => {
    expect(() => assertMeshEndpointAllowed("https://mesh.example.test", "http")).toThrow(DomainError);
  });
});
