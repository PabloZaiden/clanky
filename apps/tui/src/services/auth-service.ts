import {
  getValidatedCredentials,
  type StoredCliCredentials,
} from "@ralpher/client-sdk";

export class AuthService {
  private credentials: StoredCliCredentials | null = null;

  async getCredentials(baseUrl?: string): Promise<StoredCliCredentials> {
    const credentials = await getValidatedCredentials(
      { baseUrl },
      {
        fetchFn: fetch,
        now: () => new Date(),
      },
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
