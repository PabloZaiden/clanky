import { afterEach, describe, expect, test } from "bun:test";
import { DomainError } from "../../src/core/domain-error";
import {
  assertMeshEndpointAllowed,
  getMeshTransport,
  resolveAdvertisedMeshEndpoint,
  resolveMeshRoute,
} from "../../src/core/mesh-transport-config";

const originalPublicBaseUrl = process.env["CLANKY_PUBLIC_BASE_URL"];
const originalMeshEndpoint = process.env["CLANKY_MESH_ENDPOINT"];

afterEach(() => {
  if (originalPublicBaseUrl === undefined) {
    delete process.env["CLANKY_PUBLIC_BASE_URL"];
  } else {
    process.env["CLANKY_PUBLIC_BASE_URL"] = originalPublicBaseUrl;
  }
  if (originalMeshEndpoint === undefined) {
    delete process.env["CLANKY_MESH_ENDPOINT"];
  } else {
    process.env["CLANKY_MESH_ENDPOINT"] = originalMeshEndpoint;
  }
});

describe("mesh transport configuration", () => {
  test("accepts HTTPS without a public certificate requirement", () => {
    expect(getMeshTransport("https://mesh.example.test")).toBe("https");
    expect(assertMeshEndpointAllowed("https://mesh.example.test").protocol).toBe("https:");
  });

  test("accepts HTTP for private network endpoints", () => {
    expect(getMeshTransport("http://127.0.0.1:4100")).toBe("http");
    expect(getMeshTransport("http://192.168.1.20:4100")).toBe("http");
  });

  test("requires the configured public base URL for the advertised endpoint", () => {
    delete process.env["CLANKY_PUBLIC_BASE_URL"];
    expect(() => resolveAdvertisedMeshEndpoint()).toThrow(DomainError);

    process.env["CLANKY_PUBLIC_BASE_URL"] = "http://192.168.1.20:4100";
    expect(resolveAdvertisedMeshEndpoint()).toBe("http://192.168.1.20:4100");
  });

  test("uses the configured public URL and ignores the legacy mesh override", () => {
    process.env["CLANKY_MESH_ENDPOINT"] = "http://legacy.example.test:4100";
    process.env["CLANKY_PUBLIC_BASE_URL"] = "http://configured.example.test:4200/mesh/";

    expect(resolveAdvertisedMeshEndpoint()).toBe("http://configured.example.test:4200/mesh");
    expect(resolveMeshRoute(
      resolveAdvertisedMeshEndpoint(),
      "/api/mesh/internal/sync",
    )).toBe("http://configured.example.test:4200/mesh/api/mesh/internal/sync");
  });

  test("rejects endpoints with query strings or fragments", () => {
    expect(() => assertMeshEndpointAllowed("http://192.168.1.20:4100?mesh=1")).toThrow(DomainError);
    expect(() => assertMeshEndpointAllowed("http://192.168.1.20:4100/mesh#peer")).toThrow(DomainError);
  });

  test("rejects transport declarations that do not match the URL", () => {
    expect(() => assertMeshEndpointAllowed("https://mesh.example.test", "http")).toThrow(DomainError);
  });
});
