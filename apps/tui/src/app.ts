import { AppContext, TuiApplication } from "@pablozaiden/terminatui";
import type { AnyCommand } from "@pablozaiden/terminatui";
import { createRequire } from "node:module";
import { AuthService } from "./services/auth-service";
import { ApiClient } from "./services/api-client";
import { CommandFactory } from "./services/command-factory";
import { EntityCache } from "./services/entity-cache";
import { WsClient } from "./services/ws-client";

const require = createRequire(import.meta.url);
const packageJson = require("../package.json") as { version?: string };

export class RalpherTuiApp extends TuiApplication {
  private constructor(commands: AnyCommand[]) {
    super({
      name: "ralpher",
      displayName: "Ralpher",
      version: packageJson.version ?? "0.0.0-development",
      commands,
      logger: {
        minLevel: 2,
      },
    });
  }

  static async create(): Promise<RalpherTuiApp> {
    const authService = new AuthService();
    const apiClient = new ApiClient(authService);
    const entityCache = new EntityCache();
    const wsClient = new WsClient(authService);
    const commandFactory = new CommandFactory(apiClient, entityCache);
    const commands = await commandFactory.createRootCommands();
    const app = new RalpherTuiApp(commands);

    AppContext.current.setService("authService", authService);
    AppContext.current.setService("apiClient", apiClient);
    AppContext.current.setService("entityCache", entityCache);
    AppContext.current.setService("wsClient", wsClient);
    AppContext.current.setService("commandFactory", commandFactory);

    app.setHooks({
      onError: async (error: Error) => {
        AppContext.current.logger.error(String(error));
      },
    });

    return app;
  }
}
