/**
 * Import-free OpenCode 2 Promise plugin, materialized on the execution host.
 */

export const OPENCODE_CONTROL_PLUGIN_ID = "clanky.control";

export const OPENCODE_CONTROL_PLUGIN_SOURCE = String.raw`
export default {
  id: "clanky.control",
  async setup(ctx) {
    const url = process.env.CLANKY_OPENCODE_CONTROL_URL;
    const token = process.env.CLANKY_OPENCODE_CONTROL_TOKEN;
    if (!url || !token) throw new Error("The managed Clanky Control bridge is unavailable.");
    if (typeof ctx.tool.reload !== "function") throw new Error("Managed Clanky Control requires OpenCode tool reload support.");
    const lifetime = new AbortController();
    const request = async (path, body, signal) => {
      const response = await fetch(url + path, {
        method: body === undefined ? "GET" : "POST",
        headers: { authorization: "Bearer " + token, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(35000), ...(signal ? [signal] : [])]),
      });
      if (!response.ok) throw new Error("The managed Clanky Control bridge request failed.");
      return await response.json();
    };
    const definitions = new Map((await request("/tools")).map((definition) => [definition.name, definition]));
    const registrations = [];
    try {
      registrations.push(await ctx.tool.transform((tools) => {
        for (const definition of definitions.values()) {
          tools.add({
            name: definition.name,
            description: definition.description,
            input: definition.inputSchema,
            output: { type: "object", additionalProperties: true },
            options: { codemode: false },
            execute: async (input, invocation) => {
              const result = await request("/invoke", {
                sessionId: invocation.sessionID, name: definition.name, input,
              }, invocation.signal);
              return { output: result, content: JSON.stringify(result) };
            },
          });
        }
      }));
      registrations.push(await ctx.session.hook("prompt", async (event) => {
        const context = await request("/context", { sessionId: event.sessionID });
        let changed = false;
        for (const definition of context.tools) {
          if (JSON.stringify(definitions.get(definition.name)) !== JSON.stringify(definition)) {
            definitions.set(definition.name, definition);
            changed = true;
          }
        }
        if (changed) await ctx.tool.reload();
      }));
      registrations.push(await ctx.session.hook("context", async (event) => {
        const context = await request("/context", { sessionId: event.sessionID });
        const applicable = new Set(context.tools.map((definition) => definition.name));
        for (const name of definitions.keys()) {
          if (!context.enabled || !applicable.has(name)) delete event.tools[name];
        }
      }));
    } catch (error) {
      lifetime.abort();
      try {
        await Promise.all(registrations.map((registration) => registration.dispose()));
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "Clanky Control plugin setup and cleanup failed.");
      }
      throw error;
    }
    return async () => {
      lifetime.abort();
      await Promise.all(registrations.map((registration) => registration.dispose()));
    };
  },
};
`;
