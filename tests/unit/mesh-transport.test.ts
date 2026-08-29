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
    process.env["CLANKY_PUBLIC_BASE_URL"] = "http://configured.example.test:4200/";

    expect(resolveAdvertisedMeshEndpoint()).toBe("http://configured.example.test:4200");
    expect(resolveMeshRoute(
      resolveAdvertisedMeshEndpoint(),
      "/api/mesh/internal/membership",
    )).toBe("http://configured.example.test:4200/api/mesh/internal/membership");
  });

  test("uses an explicit Mesh endpoint override without changing the public URL", () => {
    process.env["CLANKY_PUBLIC_BASE_URL"] = "http://browser.example.test:4200";

    expect(resolveAdvertisedMeshEndpoint("http://mesh.example.test:4300"))
      .toBe("http://mesh.example.test:4300");
    expect(resolveAdvertisedMeshEndpoint()).toBe("http://browser.example.test:4200");
  });

  test("validates an explicit Mesh endpoint override", () => {
    expect(() => resolveAdvertisedMeshEndpoint("http://mesh.example.test:4300/mesh"))
      .toThrow(DomainError);
    try {
      resolveAdvertisedMeshEndpoint("http://mesh.example.test:4300/mesh");
    } catch (error) {
      expect(error).toMatchObject({ code: "mesh_endpoint_invalid" });
    }
  });

  test("rejects endpoints with query strings or fragments", () => {
    expect(() => assertMeshEndpointAllowed("http://192.168.1.20:4100?mesh=1")).toThrow(DomainError);
    expect(() => assertMeshEndpointAllowed("http://192.168.1.20:4100/mesh#peer")).toThrow(DomainError);
  });

  test("rejects endpoints with credentials", () => {
    expect(() => assertMeshEndpointAllowed("http://mesh-user:mesh-password@192.168.1.20:4100"))
      .toThrow(DomainError);
  });

  test("requires the public base URL to be an absolute origin", () => {
    process.env["CLANKY_PUBLIC_BASE_URL"] = "http://configured.example.test:4200/mesh";
    expect(() => resolveAdvertisedMeshEndpoint()).toThrow(DomainError);
    try {
      resolveAdvertisedMeshEndpoint();
    } catch (error) {
      expect(error).toMatchObject({ code: "mesh_public_base_url_invalid" });
    }
  });

  test("rejects transport declarations that do not match the URL", () => {
    expect(() => assertMeshEndpointAllowed("https://mesh.example.test", "http")).toThrow(DomainError);
  });
});
