export const ENVIRONMENT_RUNTIME_ROOT = "/var/lib/clanky";
export const ENVIRONMENT_CONTAINER_STATE_ROOT = "/usr/local/share/clanky-environment/state";

export const environmentRuntimeProfileDefaults = {
  COPILOT_HOME: `${ENVIRONMENT_RUNTIME_ROOT}/profiles/copilot`,
  CODEX_HOME: `${ENVIRONMENT_RUNTIME_ROOT}/profiles/codex`,
  CLAUDE_CONFIG_DIR: `${ENVIRONMENT_RUNTIME_ROOT}/profiles/claude`,
  GH_CONFIG_DIR: `${ENVIRONMENT_RUNTIME_ROOT}/profiles/gh`,
};

export const environmentRuntimeFeature = {
  id: "clanky-runtime",
  version: "1.0.0",
  name: "Clanky workspace runtime",
  description: "Private, non-root Clanky tooling and container-start recovery.",
  dependsOn: { "ghcr.io/devcontainers/features/node:2": {} },
  entrypoint: "/usr/local/share/clanky-environment/start.sh",
};

export const environmentRuntimeInstall = `#!/bin/sh
set -eu
user="$_REMOTE_USER"
home="$_REMOTE_USER_HOME"
[ -n "$home" ] && [ -d "$home" ] || { echo "Clanky requires a tooling user with a home directory." >&2; exit 1; }
packages=""
for pair in git:git gh:gh curl:curl dtach:dtach tmux:tmux flock:util-linux runuser:util-linux ssh:openssh-client timeout:coreutils; do
  command -v "\${pair%%:*}" >/dev/null 2>&1 || packages="$packages \${pair#*:}"
done
if [ -n "$packages" ]; then
  command -v apt-get >/dev/null 2>&1 || { echo "Clanky needs Git, gh, curl, dtach, tmux, util-linux, OpenSSH and coreutils. Install them in the project image or use a Debian/Ubuntu template." >&2; exit 1; }
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends $packages ca-certificates
  rm -rf /var/lib/apt/lists/*
fi
group=$(id -gn "$user")
for directory in "$home/.local" "$home/.local/share"; do
  [ -d "$directory" ] || install -d -m 755 -o "$user" -g "$group" "$directory"
done
runtime="$home/.local/share/clanky-environment"
install -d -m 700 -o "$user" -g "$group" "$runtime"
[ ! -e /var/lib/clanky ] && [ ! -L /var/lib/clanky ] || { echo "The project image already uses /var/lib/clanky." >&2; exit 1; }
ln -s "$runtime" /var/lib/clanky
install -d -m 755 /usr/local/share/clanky-environment
install -d -m 700 -o "$user" -g "$group" "$runtime-container"
ln -s "$runtime-container" ${ENVIRONMENT_CONTAINER_STATE_ROOT}
node -e 'require("node:fs").writeFileSync(process.argv[1],JSON.stringify({user:process.argv[2],home:process.argv[3],runtime:process.argv[4]}))' /usr/local/share/clanky-environment/runtime.json "$user" "$home" "$runtime"
printf '%s\\n' "$user" > /usr/local/share/clanky-environment/user
install -m 755 start.sh /usr/local/share/clanky-environment/start.sh
install -m 644 launch.cjs /usr/local/share/clanky-environment/launch.cjs
`;

export const environmentRuntimeLaunch = `const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const root = "/var/lib/clanky";
const environment = { ...process.env };
for (const [name, value] of Object.entries(JSON.parse(fs.readFileSync("${ENVIRONMENT_CONTAINER_STATE_ROOT}/remote-env.json", "utf8")))) {
  if (value === null) delete environment[name];
  else if (typeof value === "string") environment[name] = value;
  else throw new Error("Invalid saved project environment.");
}
const result = spawnSync("/bin/sh", ["-c", fs.readFileSync(root + "/startup-command", "utf8")], {
  env: environment, stdio: "inherit",
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
`;

export const environmentRuntimeStart = `#!/bin/sh
set -eu
root=/var/lib/clanky
user=$(cat /usr/local/share/clanky-environment/user)
uid=$(id -u "$user")
command='umask 077
process=$(cat /proc/1/stat); process=\${process##*) }; set -- $process; shift 19; boot=$1
if [ ! -f ${ENVIRONMENT_CONTAINER_STATE_ROOT}/remote-env.json ]; then
  printf "%s:unconfigured\\n" "$boot" > /var/lib/clanky/startup-state
  exit 0
fi
[ -f /var/lib/clanky/startup-command ] || exit 0
printf "%s:starting\\n" "$boot" > /var/lib/clanky/startup-state
if node /usr/local/share/clanky-environment/launch.cjs >> /var/lib/clanky/startup.log 2>&1; then
  printf "%s:success\\n" "$boot" > /var/lib/clanky/startup-state
else
  printf "%s:failed\\n" "$boot" > /var/lib/clanky/startup-state
  exit 1
fi'
start() {
  if [ "$(id -u)" -eq "$uid" ]; then
    sh -c "$command"
  elif [ "$(id -u)" -eq 0 ]; then
    runuser -u "$user" -- sh -c "$command"
  else
    echo "Clanky cannot start as remoteUser $user from a different non-root containerUser. The project's users were not changed." >&2
    return 1
  fi
}
if ! start; then
  echo "Clanky worker startup failed. Use clanky environment shell from the provisioning host and inspect $root/startup.log." >&2
fi
`;
