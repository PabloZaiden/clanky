import { runUpdateCommand as runInstallerUpdateCommand, type UpdaterDependencies } from "@pablozaiden/installer";

const GITHUB_REPOSITORY = "pablozaiden/ralpher";
const CLI_BINARY_NAME = "ralpher-cli";
const SERVER_BINARY_NAME = "ralpher";

export interface UpdateCommandOptions {
  checkOnly: boolean;
  version?: string;
}

export type CliUpdateDependencies = Partial<UpdaterDependencies> & {
  currentVersion?: string;
};

export const RALPHER_UPDATER_CONFIG = {
  repository: GITHUB_REPOSITORY,
  binaryName: CLI_BINARY_NAME,
  currentVersion: "0.0.0-development",
  productName: "Ralpher CLI",
  checksum: { required: true },
  companionBinaries: [
    {
      binaryName: SERVER_BINARY_NAME,
      assetPrefix: SERVER_BINARY_NAME,
      required: false,
    },
  ],
};

export async function runUpdateCommand(
  command: UpdateCommandOptions,
  dependencyOverrides: CliUpdateDependencies = {},
): Promise<number> {
  const { currentVersion, ...installerDependencyOverrides } = dependencyOverrides;
  return await runInstallerUpdateCommand(
    command,
    {
      ...RALPHER_UPDATER_CONFIG,
      currentVersion: currentVersion ?? RALPHER_UPDATER_CONFIG.currentVersion,
    },
    installerDependencyOverrides,
  );
}
