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
    const definitions = await request("/tools");
    const registrations = [];
    try {
      registrations.push(await ctx.tool.transform((tools) => {
        for (const definition of definitions) {
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
      registrations.push(await ctx.session.hook("context", async (event) => {
        const context = await request("/context", { sessionId: event.sessionID });
        if (!context.enabled) {
          for (const definition of definitions) delete event.tools[definition.name];
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
