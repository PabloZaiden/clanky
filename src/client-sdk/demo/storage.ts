export const DEMO_CONTROLLER_ENDPOINT = "https://demo-controller";

let storage: Storage | undefined;

export function isDemoControllerEndpoint(value: string): boolean {
  const url = new URL(value.trim());
  return url.origin === DEMO_CONTROLLER_ENDPOINT && url.pathname === "/"
    && !url.username && !url.password && !url.search && !url.hash;
}

export function getDemoStorage(): Storage | undefined { return storage; }

export function startDemoStorage(): void {
  const values = new Map<string, string>();
  storage = {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: key => { values.delete(key); },
    key: index => [...values.keys()][index] ?? null,
  };
}
