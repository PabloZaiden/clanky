/**
 * Canonical owned paths and durable Devbox startup assets.
 */

import { posix as pathPosix } from "node:path";
import { AGENT_PROVIDER_IDS, createAgentSettings, type HarnessAdapter } from "@/shared/settings";

export interface WorkerPaths {
  hostRoot: string;
  containerRoot: string;
  containerBinary: string;
  containerData: string;
  containerLauncher: string;
  containerLog: string;
  containerPid: string;
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function getWorkerPaths(targetDirectory: string, containerWorkdir: string): WorkerPaths {
  const hostRoot = pathPosix.join(targetDirectory, ".devbox", "clanky-worker");
  const containerRoot = pathPosix.join(containerWorkdir, ".devbox", "clanky-worker");
  return {
    hostRoot, containerRoot,
    containerBinary: pathPosix.join(containerRoot, "bin", "clanky"),
    containerData: pathPosix.join(containerRoot, "data"),
    containerLauncher: pathPosix.join(containerRoot, "launcher.sh"),
    containerLog: pathPosix.join(containerRoot, "worker.log"),
    containerPid: pathPosix.join(containerRoot, "worker.pid"),
  };
}

const NATIVE_RUNTIME_PACKAGES = {
  copilot: { package: "@github/copilot", version: "1.0.91", executable: "copilot" },
  codex: { package: "@openai/codex", version: "0.159.2", executable: "codex" },
  opencode2: { package: "@opencode/cli", version: "2.0.20", executable: "opencode" },
} as const;

const DEV_CONTAINERS_NODE_BIN = "/usr/local/share/nvm/current/bin";

function buildNodePathFallback(): string {
  return `if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  node_bin=${shellQuote(DEV_CONTAINERS_NODE_BIN)}
  if [ -x "$node_bin/node" ] && [ -x "$node_bin/npm" ]; then
    PATH="$node_bin\${PATH:+:$PATH}"
    export PATH
  fi
fi
`;
}

export function buildRuntimeInstaller(): string {
  const providers = Object.fromEntries(Object.keys(NATIVE_RUNTIME_PACKAGES).map((adapter) => [
    adapter, createAgentSettings(adapter as HarnessAdapter, "copilot").provider,
  ]));
  return `#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
manifest=\${1:-"$root/runtime.json"}
${buildNodePathFallback()}
command -v node >/dev/null || { echo "Native runtime installation requires Node.js." >&2; exit 1; }
command -v npm >/dev/null || { echo "Native runtime installation requires npm." >&2; exit 1; }
adapter=$(node -e 'const fs = require("node:fs"); const c = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); const providers = ${JSON.stringify(providers)}; const presets = ${JSON.stringify(AGENT_PROVIDER_IDS)}; if (!c || !(c.adapter === "acp" ? presets.includes(c.provider) : Object.hasOwn(providers, c.adapter) && providers[c.adapter] === c.provider)) throw new Error("Invalid workspace runtime selection"); process.stdout.write(c.adapter);' "$manifest")
mkdir -p "$root/runtime/bin"
case "$adapter" in
  acp) exit 0 ;;
${Object.entries(NATIVE_RUNTIME_PACKAGES).map(([adapter, entry]) =>
    `  ${adapter}) package=${shellQuote(entry.package)}; version=${shellQuote(entry.version)}; executable=${shellQuote(entry.executable)} ;;`).join("\n")}
  *) echo "Unsupported native adapter." >&2; exit 1 ;;
esac
platform=$(node -p 'process.platform + "-" + process.arch')
prefix="$root/runtime/$adapter-$version-$platform"
check() {
  [ -x "$1/node_modules/.bin/$executable" ] &&
  node -e 'const p = require(process.argv[1]); if (p.version !== process.argv[2]) process.exit(1);' "$1/node_modules/$package/package.json" "$version" &&
  reported=$("$1/node_modules/.bin/$executable" --version) &&
  node -e 'const versions = process.argv[1].match(/\\d+(?:\\.\\d+){2,}/g) || []; if (!versions.includes(process.argv[2])) throw new Error("Native CLI version mismatch");' "$reported" "$version"
}
valid() { check "$prefix"; }
if ! valid; then
  stage=$(mktemp -d "$root/runtime/.install-$adapter-XXXXXX")
  trap 'rm -rf -- "$stage"' EXIT
  echo "Installing $package@$version for this workspace."
  node -e 'const fs = require("node:fs"); fs.writeFileSync(process.argv[1] + "/package.json", JSON.stringify({name:"clanky-workspace-runtime",private:true,allowScripts:{[process.argv[2]]:true}}));' "$stage" "$package"
  npm install --prefix "$stage" --save-exact --omit=dev --no-audit --no-fund "$package@$version"
  check "$stage"
  echo "$package CLI version $version verified."
  if [ -d "$prefix" ]; then
    if valid; then
      rm -rf -- "$stage"
    else
      echo "The existing managed runtime is damaged; remove $prefix and retry." >&2
      exit 1
    fi
  else
    if ! mv -T -- "$stage" "$prefix"; then
      if valid; then rm -rf -- "$stage"; else exit 1; fi
    fi
  fi
  trap - EXIT
fi
link="$root/runtime/bin/.$adapter-$(node -p 'require("node:crypto").randomUUID()')"
trap 'rm -f -- "$link"' EXIT
ln -s "../$adapter-$version-$platform/node_modules/.bin/$executable" "$link"
mv -f -- "$link" "$root/runtime/bin/$([ "$adapter" = opencode2 ] && echo opencode2 || echo "$executable")"
trap - EXIT
`;
}

export function buildWorkerLauncher(paths: WorkerPaths): string {
  return `#!/bin/sh
set -eu
root=${shellQuote(paths.containerRoot)}
bin_dir=${shellQuote(pathPosix.join(paths.containerRoot, "bin"))}
data_dir=${shellQuote(paths.containerData)}
binary=${shellQuote(paths.containerBinary)}
installer=${shellQuote(pathPosix.join(paths.containerRoot, "bin", ".installer.sh"))}
install_dir=${shellQuote(pathPosix.join(paths.containerRoot, "bin", ".install"))}
install_home=${shellQuote(pathPosix.join(paths.containerRoot, "bin", ".install-home"))}
installed_binary="$install_home/.local/bin/clanky"
log_file=${shellQuote(paths.containerLog)}
pid_file=${shellQuote(paths.containerPid)}

${buildNodePathFallback()}
sh "$root/install-runtime.sh"
PATH="$root/runtime/bin:$PATH"
export PATH
mkdir -p "$bin_dir" "$data_dir" "$install_dir" "$install_home"
curl -fsSL --proto '=https' --tlsv1.2 https://raw.githubusercontent.com/pablozaiden/installer/1e73c9a4b84bb2282d5a6fd8463f9a9f62c26c67/install.sh -o "$installer"
printf '%s  %s\\n' d377a7ed04b150781b94cb0af97e6f7a2efe2c8d12dae1a1f0aa825306ea28f3 "$installer" | sha256sum -c -
HOME="$install_home" sh "$installer" pablozaiden/clanky --install-dir "$install_dir" --checksum required
if [ -x "$install_dir/clanky" ]; then
  source_binary="$install_dir/clanky"
elif [ -x "$installed_binary" ]; then
  source_binary="$installed_binary"
else
  echo "The Clanky installer did not produce an executable binary." >&2
  exit 1
fi
mv -f "$source_binary" "$binary"
rm -rf "$install_dir" "$install_home"
rm -f "$installer"

if [ ! -f "$data_dir/config.json" ]; then exit 0; fi
if [ -s "$pid_file" ]; then
  worker_pid=$(cat "$pid_file")
  if kill -0 "$worker_pid" 2>/dev/null; then
    if [ -r "/proc/$worker_pid/cmdline" ]; then
      worker_command=$(tr '\\000' ' ' <"/proc/$worker_pid/cmdline" 2>/dev/null || true)
      case "$worker_command" in *"$binary"*) exit 0 ;; esac
    else
      exit 0
    fi
  fi
  rm -f "$pid_file"
fi
nohup env CLANKY_DATA_DIR="$data_dir" "$binary" serve </dev/null >>"$log_file" 2>&1 &
worker_pid=$!
printf '%s\\n' "$worker_pid" >"$pid_file"
`;
}
