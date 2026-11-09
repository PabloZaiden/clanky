import { readWebAppConfig } from "@pablozaiden/webapp/server";
import { X509Certificate } from "node:crypto";
import type { WebAppCliCommandDefinition } from "@/platform/cli";
import { configureControllerTls } from "../core/controller-tls";
import { getDataDir } from "../persistence/database";
import { readControllerTlsIdentity } from "../persistence/controller-tls";
import type { ClankyCliContext } from "./mesh";

export function createControllerCommand(): WebAppCliCommandDefinition<ClankyCliContext> {
  return {
    description: "Configure optional managed HTTPS on the controller's existing listener.",
    usage: [
      "controller tls enable --endpoint HTTPS_ORIGIN",
      "controller tls rotate [--endpoint HTTPS_ORIGIN]",
      "controller tls disable",
      "controller tls export",
      "controller tls status",
      "",
      "Configuration applies on the next explicit controller restart.",
      "Rotation replaces TLS trust: re-enroll workers and replace browser trust.",
    ].join("\n"),
    async handler(context) {
      const [category, operation, ...args] = context.args;
      if (category !== "tls" || !["enable", "rotate", "disable", "export", "status"].includes(operation ?? "")) {
        throw new Error("Use controller tls <enable|rotate|disable|export|status>.");
      }
      let endpoint: string | undefined;
      if (args.length) {
        if (!["enable", "rotate"].includes(operation!) || args.length !== 2 || args[0] !== "--endpoint" || !args[1]) {
          throw new Error("Only enable/rotate accept --endpoint HTTPS_ORIGIN.");
        }
        endpoint = args[1];
      }
      if (operation === "export" || operation === "status") {
        const enabled = readWebAppConfig(getDataDir()).serve?.options?.["managed-tls"] === true;
        const identity = operation === "export" || enabled ? await readControllerTlsIdentity() : null;
        if (operation === "export") {
          if (!identity) throw new Error("Managed controller TLS is not initialized.");
          context.stdout.write(identity.certificate);
        } else {
          context.stdout.write(`${JSON.stringify({
            enabled,
            endpoint: identity?.endpoint ?? null,
            certificate: identity?.certificate ?? null,
            fingerprint: identity?.fingerprint ?? null,
            notBefore: identity ? new Date(new X509Certificate(identity.certificate).validFrom).toISOString() : null,
            notAfter: identity ? new Date(new X509Certificate(identity.certificate).validTo).toISOString() : null,
          })}\n`);
        }
        return { exitCode: 0 };
      }
      if (operation === "enable" && !endpoint) throw new Error("controller tls enable requires --endpoint.");
      const identity = await configureControllerTls({
        enabled: operation !== "disable",
        endpoint,
        rotate: operation === "rotate",
      });
      context.stderr.write("Restart the controller explicitly to apply this change; active connections will be interrupted.\n");
      if (operation === "rotate") context.stderr.write("TLS trust was replaced. Re-enroll workers and replace browser certificate trust.\n");
      context.stdout.write(`${JSON.stringify({
        enabled: operation !== "disable",
        endpoint: identity?.endpoint ?? null,
        fingerprint: identity?.fingerprint ?? null,
        restartRequired: true,
      })}\n`);
      return { exitCode: 0 };
    },
  };
}
