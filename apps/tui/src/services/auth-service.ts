import {
  getValidatedCredentials,
  validateStoredCredentials,
  type StoredCliCredentials,
} from "@ralpher/client-sdk";

export interface AuthServiceDependencies {
  fetchFn?: typeof fetch;
  now?: () => Date;
}

export class AuthService {
  private credentials: StoredCliCredentials | null = null;

  constructor(private readonly dependencies: AuthServiceDependencies = {}) {}

  async getCredentials(baseUrl?: string): Promise<StoredCliCredentials> {
    const authDependencies = {
      fetchFn: this.dependencies.fetchFn ?? fetch,
      now: this.dependencies.now ?? (() => new Date()),
    };
    const credentials = this.credentials
      ? await validateStoredCredentials(
        this.credentials,
        { baseUrl },
        authDependencies,
      )
      : await getValidatedCredentials(
        { baseUrl },
        authDependencies,
      );

    if (!credentials) {
      throw new Error("Not logged in. Run the Ralpher CLI auth flow before opening the TUI.");
    }

    this.credentials = credentials;
    return credentials;
  }

  async getBaseUrl(): Promise<string> {
    return (await this.getCredentials()).baseUrl;
  }

  getCachedCredentials(): StoredCliCredentials | null {
    return this.credentials;
  }
}
