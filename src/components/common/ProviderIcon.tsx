import type { AgentProvider } from "@/shared/settings";
import { ChatIcon } from "./Icons";
import openaiMarkPath from "./provider-icons/openai-mark.svg" with { type: "file" };
import copilotPath from "./provider-icons/copilot-24.svg" with { type: "file" };
import opencodeDarkThemePath from "./provider-icons/opencode-logo-dark-square.svg" with { type: "file" };
import opencodeLightThemePath from "./provider-icons/opencode-logo-light-square.svg" with { type: "file" };

export type ProviderIconKind = "opencode" | "codex" | "copilot" | "generic";

export function getProviderIconKind(provider: AgentProvider | string): ProviderIconKind {
  if (provider === "opencode" || provider === "codex" || provider === "copilot") {
    return provider;
  }
  return "generic";
}

export function ProviderIcon({
  provider,
  size = "h-3.5 w-3.5",
  className = "",
}: {
  provider: AgentProvider | string;
  size?: string;
  className?: string;
}) {
  const kind = getProviderIconKind(provider);
  const imageClassName = `${size} shrink-0 object-contain ${className}`.trim();

  if (kind === "opencode") {
    return (
      <>
        <img
          className={`${imageClassName} dark:hidden`}
          src={opencodeLightThemePath}
          alt=""
          aria-hidden="true"
        />
        <img
          className={`${imageClassName} hidden dark:inline-block`}
          src={opencodeDarkThemePath}
          alt=""
          aria-hidden="true"
        />
      </>
    );
  }

  if (kind === "generic") {
    return <ChatIcon size={size} className={`shrink-0 ${className}`} />;
  }

  return (
    <img
      className={`${imageClassName} dark:invert`}
      src={kind === "codex" ? openaiMarkPath : copilotPath}
      alt=""
      aria-hidden="true"
    />
  );
}
