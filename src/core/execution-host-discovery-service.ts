/**
 * Transport-neutral prerequisite and Devbox discovery for execution hosts.
 */

import type {
  DevboxTemplateSummary,
  ExecutionHostRef,
  SshServerPrerequisiteReport,
} from "@/shared";
import { isIPv4 } from "node:net";
import { serializeExecutionHostRef } from "@/shared/execution-host";
import { parseDevboxTemplatesOutput } from "./ssh-server-devbox-templates";
import {
  executionHostService,
  type ExecutionHostCommandContext,
} from "./execution-host-service";
import { checkExecutionHostPrerequisites } from "./ssh-server-prerequisites";
import { DEVBOX_REQUIRED_VERSION, parseDevboxVersion } from "./devbox-version";
import { DomainError } from "./domain-error";

export interface ExecutionHostDiscoveryContext extends ExecutionHostCommandContext {
  repositoriesBasePath: string | null;
  responseId?: string;
}

function transportLabel(ref: ExecutionHostRef): string {
  if (ref.kind === "ssh") {
    return "SSH";
  }
  return ref.kind === "mesh" ? "Mesh" : "Local";
}

function isExcludedInterface(interfaceName: string): boolean {
  const baseName = interfaceName.split("@", 1)[0] ?? interfaceName;
  return /^(veth.+|virbr\d*|cni\d*|flannel.+|cali.+)$/i.test(baseName);
}

function isExcludedAddress(address: string): boolean {
  const octets = address.split(".").map(Number);
  return octets[0] === 127
    || (octets[0] === 169 && octets[1] === 254);
}

export function parseAccessibleIpv4Addresses(output: string): string[] {
  const addresses = new Set<string>();
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(
      /^\d+:\s+([^\s]+)\s+inet\s+([0-9.]+)\/\d+\s+.*?\bscope\s+([^\s]+)/,
    );
    if (!match || match[3] === "host" || match[3] === "link") {
      continue;
    }
    const interfaceName = match[1]!;
    const address = match[2]!;
    if (
      isExcludedInterface(interfaceName)
      || !isIPv4(address)
      || isExcludedAddress(address)
    ) {
      continue;
    }
    addresses.add(address);
  }
  return [...addresses].sort();
}

function parseFallbackIpv4Addresses(output: string): string[] {
  const addresses = new Set<string>();
  for (const value of output.split(/\s+/)) {
    if (isIPv4(value) && !isExcludedAddress(value)) {
      addresses.add(value);
    }
  }
  return [...addresses].sort();
}

export class ExecutionHostDiscoveryService {
  async checkPrerequisites(
    ref: ExecutionHostRef,
    context: ExecutionHostDiscoveryContext,
  ): Promise<SshServerPrerequisiteReport> {
    const executor = await executionHostService.getCommandExecutorForRef(ref, context);
    return await checkExecutionHostPrerequisites({
      targetId: context.responseId ?? serializeExecutionHostRef(ref),
      connectionLabel: transportLabel(ref),
      repositoriesBasePath: context.repositoriesBasePath,
    }, executor);
  }

  async listDevboxTemplates(
    ref: ExecutionHostRef,
    context: ExecutionHostCommandContext,
  ): Promise<DevboxTemplateSummary[]> {
    const executor = await executionHostService.getCommandExecutorForRef(ref, context);
    const versionResult = await executor.exec("devbox", ["--help"], { cwd: "/" });
    const version = parseDevboxVersion(versionResult.stdout);
    if (!versionResult.success || version !== DEVBOX_REQUIRED_VERSION) {
      throw new DomainError(
        "execution_host_templates_failed",
        "Failed to list Devbox templates on the execution host.",
        {
          details: {
            executionHost: serializeExecutionHostRef(ref),
            devboxVersion: version ?? "unknown",
            requiredDevboxVersion: DEVBOX_REQUIRED_VERSION,
          },
        },
      );
    }

    const result = await executor.exec("devbox", ["templates"], { cwd: "/" });
    if (!result.success) {
      throw new DomainError(
        "execution_host_templates_failed",
        "Failed to list Devbox templates on the execution host.",
        {
          details: {
            executionHost: serializeExecutionHostRef(ref),
            exitCode: result.exitCode,
          },
        },
      );
    }
    return parseDevboxTemplatesOutput(result.stdout);
  }

  async listAccessibleIpv4Addresses(
    ref: ExecutionHostRef,
    context: ExecutionHostCommandContext,
  ): Promise<string[]> {
    const executor = await executionHostService.getCommandExecutorForRef(ref, context);
    const result = await executor.exec(
      "ip",
      ["-4", "-o", "addr", "show", "up"],
      { cwd: "/" },
    );
    const addresses = result.success
      ? parseAccessibleIpv4Addresses(result.stdout)
      : [];
    if (addresses.length > 0) {
      return addresses;
    }

    const fallback = await executor.exec("hostname", ["-I"], { cwd: "/" });
    const fallbackAddresses = fallback.success
      ? parseFallbackIpv4Addresses(fallback.stdout)
      : [];
    if (fallbackAddresses.length > 0) {
      return fallbackAddresses;
    }

    throw new DomainError(
      "execution_host_addresses_unavailable",
      "No accessible IPv4 address was found on the execution host.",
      {
        details: {
          executionHost: serializeExecutionHostRef(ref),
          ipExitCode: result.exitCode,
          hostnameExitCode: fallback.exitCode,
        },
      },
    );
  }
}

export const executionHostDiscoveryService = new ExecutionHostDiscoveryService();
