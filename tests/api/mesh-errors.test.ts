import { describe, expect, test } from "bun:test";
import { meshErrorResponse } from "../../src/api/mesh";
import { DomainError } from "../../src/domain/domain-error";

async function readJson(response: Response): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>;
}

describe("mesh API error mapping", () => {
  test("distinguishes public URL configuration failures from endpoint input failures", async () => {
    const publicUrlResponse = meshErrorResponse(new DomainError(
      "mesh_public_base_url_invalid",
      "internal configuration detail",
    ));
    expect(publicUrlResponse.status).toBe(503);
    await expect(readJson(publicUrlResponse)).resolves.toMatchObject({
      error: "mesh_public_base_url_invalid",
      message: "CLANKY_PUBLIC_BASE_URL must be an absolute HTTP(S) origin without credentials, a path, a query, or a fragment",
    });

    const endpointResponse = meshErrorResponse(new DomainError(
      "mesh_endpoint_invalid",
      "internal endpoint detail",
    ));
    expect(endpointResponse.status).toBe(400);
    await expect(readJson(endpointResponse)).resolves.toMatchObject({
      error: "mesh_endpoint_invalid",
      message: "The mesh endpoint must be a valid HTTP(S) URL without credentials, a query, or a fragment",
    });
  });
});
