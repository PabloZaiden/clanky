import { join } from "node:path";
import {
  createJsonFileStore,
  type JsonFileStore,
} from "./credentials";
import {
  createDeviceCredentialsStore,
  type StoredDeviceCredentials,
} from "./device-auth";

interface CliProfileIndex {
  version: 1;
  currentProfile?: string;
  profiles: string[];
}

export interface CliProfileSummary {
  name: string;
  current: boolean;
  baseUrl?: string;
}

export interface CliProfileStore {
  selectedName(explicitName?: string): Promise<string>;
  list(): Promise<CliProfileSummary[]>;
  use(name: string): Promise<void>;
  remove(name: string): Promise<boolean>;
  credentials(name: string): JsonFileStore<StoredDeviceCredentials>;
}

export interface CliProfileStoreOptions {
  appDirectoryName: string;
  envHome?: string;
  home?: string;
  stateDirectory?: () => string;
}

const DEFAULT_PROFILE = "default";
const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function validateCliProfileName(name: string): string {
  const trimmed = name.trim();
  if (!PROFILE_NAME.test(trimmed) || trimmed === "." || trimmed === "..") {
    throw new Error("Profile names must use 1-64 letters, numbers, dots, underscores, or hyphens");
  }
  return trimmed;
}

function parseProfileIndex(value: unknown): CliProfileIndex {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("CLI profile index must be an object");
  }
  const record = value as Record<string, unknown>;
  if (record["version"] !== 1 || !Array.isArray(record["profiles"])) {
    throw new Error("CLI profile index is invalid");
  }
  const profiles = record["profiles"].map((name) => validateCliProfileName(String(name)));
  const currentProfile = record["currentProfile"];
  return {
    version: 1,
    profiles: [...new Set(profiles)].sort(),
    currentProfile: currentProfile === undefined
      ? undefined
      : validateCliProfileName(String(currentProfile)),
  };
}

export function createCliProfileStore(input: CliProfileStoreOptions): CliProfileStore {
  const indexStore = createJsonFileStore<CliProfileIndex>({
    appDirectoryName: input.appDirectoryName,
    fileName: "profiles.json",
    envHome: input.envHome,
    home: input.home,
    stateDirectory: input.stateDirectory,
    parse: parseProfileIndex,
  });
  const credentialStores = new Map<string, JsonFileStore<StoredDeviceCredentials>>();

  async function readIndex(): Promise<CliProfileIndex> {
    return await indexStore.read() ?? { version: 1, profiles: [] };
  }

  async function updateIndex(update: (current: CliProfileIndex) => CliProfileIndex): Promise<void> {
    await indexStore.withLock!(async () => {
      await indexStore.write(update(await readIndex()));
    });
  }

  function rawCredentials(name: string): JsonFileStore<StoredDeviceCredentials> {
    const profileName = validateCliProfileName(name);
    let store = credentialStores.get(profileName);
    if (!store) {
      store = createDeviceCredentialsStore({
        appDirectoryName: join(input.appDirectoryName, "profiles", profileName),
        envHome: input.envHome,
        home: input.home,
        stateDirectory: input.stateDirectory
          ? () => join(input.stateDirectory!(), "profiles", profileName)
          : undefined,
      });
      credentialStores.set(profileName, store);
    }
    return store;
  }

  function credentials(name: string): JsonFileStore<StoredDeviceCredentials> {
    const profileName = validateCliProfileName(name);
    const store = rawCredentials(profileName);
    return {
      path: store.path,
      read: store.read,
      async write(value) {
        await store.write(value);
        await updateIndex((current) => ({
          ...current,
          profiles: [...new Set([...current.profiles, profileName])].sort(),
        }));
      },
      async clear() {
        await store.clear();
      },
      withLock: store.withLock,
    };
  }

  return {
    async selectedName(explicitName) {
      if (explicitName !== undefined) return validateCliProfileName(explicitName);
      return (await readIndex()).currentProfile ?? DEFAULT_PROFILE;
    },
    async list() {
      const index = await readIndex();
      const summaries = await Promise.all(index.profiles.map(async (name) => ({
        name,
        current: name === index.currentProfile,
        baseUrl: (await rawCredentials(name).read())?.baseUrl,
      })));
      return summaries.sort((left, right) => left.name.localeCompare(right.name));
    },
    async use(name) {
      const profileName = validateCliProfileName(name);
      const index = await readIndex();
      if (!index.profiles.includes(profileName)) {
        throw new Error(`Unknown profile: ${profileName}`);
      }
      await updateIndex((current) => ({ ...current, currentProfile: profileName }));
    },
    async remove(name) {
      const profileName = validateCliProfileName(name);
      const index = await readIndex();
      if (!index.profiles.includes(profileName)) return false;
      await rawCredentials(profileName).clear();
      await updateIndex((current) => ({
        ...current,
        currentProfile: current.currentProfile === profileName ? undefined : current.currentProfile,
        profiles: current.profiles.filter((candidate) => candidate !== profileName),
      }));
      return true;
    },
    credentials,
  };
}
