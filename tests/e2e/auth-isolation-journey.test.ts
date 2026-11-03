import { expect, test } from "bun:test";
import { E2EApplication } from "./support/application";
import { createGitFixture } from "./support/git";
import { CookieJar, bootstrapOwner, completeUserSetup, requestWithCookies } from "./support/passkey";

test("authenticated users keep their private workspace and administration boundaries", async () => {
  const application = await E2EApplication.create();
  try {
    await application.start({ disablePasskey: false, requestHostname: "localhost" });
    const owner = new CookieJar();
    await bootstrapOwner(application, owner);
    expect((await application.request("/api/workspaces")).status).toBe(401);
    const created = await requestWithCookies(application, owner, "/api/users", {
      method: "POST", body: JSON.stringify({ username: "project-member", role: "user" }),
    });
    expect(created.status).toBe(201);
    const user = await created.json() as { setupLink: { url: string } };
    const token = new URL(user.setupLink.url).searchParams.get("token");
    if (!token) throw new Error("Member setup token unavailable");
    const member = new CookieJar();
    await completeUserSetup(application, member, token);

    async function key(cookies: CookieJar): Promise<string> {
      const response = await requestWithCookies(application, cookies, "/api/api-keys", {
        method: "POST", body: JSON.stringify({ name: "Sanity client", scopes: ["*"] }),
      });
      expect(response.status).toBe(200);
      return (await response.json() as { token: string }).token;
    }
    const ownerKey = await key(owner);
    const memberKey = await key(member);
    const git = await createGitFixture(application.runDirectory);
    const hosts = (await application.json<Array<{ ref: Record<string, string> }>>(
      "/api/execution-hosts", { apiKey: ownerKey },
    )).data;
    const host = hosts.find((entry) => entry.ref["kind"] === "local");
    if (!host) throw new Error("Local execution host unavailable");
    const workspace = (await application.json<{ id: string }>("/api/workspaces", {
      method: "POST", apiKey: ownerKey,
      body: JSON.stringify({
        name: "Private project", directory: git.repositoryDirectory, executionHost: host.ref,
        serverSettings: { agent: { adapter: "acp", provider: "copilot" } },
      }),
    }, 201)).data;
    expect((await application.json<Array<{ id: string }>>("/api/workspaces", { apiKey: ownerKey }))
      .data.map((entry) => entry.id)).toEqual([workspace.id]);
    expect((await application.json<unknown[]>("/api/workspaces", { apiKey: memberKey })).data).toEqual([]);
    expect((await application.request(`/api/workspaces/${workspace.id}`, { apiKey: memberKey })).status).toBe(404);
    expect((await application.request("/api/users", { apiKey: memberKey })).status).toBe(403);
    expect((await application.request("/api/users", { apiKey: ownerKey })).status).toBe(200);
  } catch (error) {
    console.error(await application.diagnostics());
    throw error;
  } finally {
    await application.cleanup();
  }
});
