import { afterEach, describe, expect, test } from "bun:test";
import { DomainError } from "../../src/core/domain-error";
import {
  assertMeshEndpointAllowed,
  resolveAdvertisedMeshEndpoint,
} from "../../src/core/mesh-transport-config";
import { requestMeshPeer } from "../../src/core/mesh-peer-transport";
import {
  isMeshRelayLoopbackHostname,
  normalizeMeshRelayOrigin,
} from "../../src/shared/mesh-relay";

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
  test("requires the configured public base URL for the advertised endpoint", () => {
    delete process.env["CLANKY_PUBLIC_BASE_URL"];
    expect(() => resolveAdvertisedMeshEndpoint()).toThrow(DomainError);

    process.env["CLANKY_PUBLIC_BASE_URL"] = "http://192.168.1.20:4100";
    expect(resolveAdvertisedMeshEndpoint()).toBe("http://192.168.1.20:4100");
  });

  test("rejects unsafe or inconsistent advertised endpoints", () => {
    const invalidEndpoints = [
      "http://mesh.example.test:4300/mesh",
      "http://192.168.1.20:4100?mesh=1",
      "http://192.168.1.20:4100/mesh#peer",
      "http://user:password@192.168.1.20:4100",
    ];
    for (const endpoint of invalidEndpoints) {
      expect(() => assertMeshEndpointAllowed(endpoint)).toThrow(DomainError);
    }
    expect(() => assertMeshEndpointAllowed("https://mesh.example.test", "http"))
      .toThrow(DomainError);

    process.env["CLANKY_PUBLIC_BASE_URL"] = "http://configured.example.test:4200/mesh";
    expect(() => resolveAdvertisedMeshEndpoint()).toThrow(DomainError);
  });

  // Missing certificate pins must never downgrade an enrolled HTTPS worker to
  // system PKI, because the pin is the worker's transport identity.
  test("fails closed when a pinned HTTPS route has incomplete trust material", () => {
    expect(() => requestMeshPeer({
      kind: "direct",
      endpoint: "https://worker.example",
      transport: "https",
      tlsTrust: "pinned",
      tlsCertificate: null,
      tlsFingerprint: null,
    }, "/api/mesh/internal/health", {
      fetch: globalThis.fetch,
    })).toThrow(DomainError);
  });

  test("allows plaintext relays only on loopback origins", () => {
    expect(normalizeMeshRelayOrigin("http://localhost:8080"))
      .toBe("http://localhost:8080");
    expect(normalizeMeshRelayOrigin("http://127.23.45.67:8080"))
      .toBe("http://127.23.45.67:8080");
    expect(normalizeMeshRelayOrigin("http://[::1]:8080"))
      .toBe("http://[::1]:8080");
    expect(isMeshRelayLoopbackHostname("127.255.255.255")).toBe(true);
    expect(() => normalizeMeshRelayOrigin("http://relay.example.com"))
      .toThrow("Remote relay URLs must use HTTPS.");
    expect(normalizeMeshRelayOrigin("https://relay.example.com"))
      .toBe("https://relay.example.com");
  });
});
