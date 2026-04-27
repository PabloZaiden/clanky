import type { ReactNode } from "react";

const runtimeModule = await import(
  new URL("../../../../node_modules/.bun/node_modules/@pablozaiden/terminatui/src/index.ts", import.meta.url).href,
) as RuntimeModule;

export interface CommandResult {
  success: boolean;
  data?: unknown;
  error?: string;
  message?: string;
}

class ConfigValidationErrorBase extends Error {
  constructor(
    message: string,
    public readonly field?: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ConfigValidationError";
  }
}

type RuntimeModule = {
  Command: typeof CommandBase;
  ConfigValidationError: typeof ConfigValidationErrorBase;
  TuiApplication: typeof TuiApplicationBase;
  AppContext: typeof AppContextBase;
};

export interface OptionDef {
  type: "string" | "number" | "boolean" | "array";
  description: string;
  alias?: string;
  default?: unknown;
  required?: boolean;
  enum?: readonly string[];
  min?: number;
  max?: number;
  label?: string;
  order?: number;
  group?: string;
  placeholder?: string;
  tuiHidden?: boolean;
}

export type OptionSchema = Record<string, OptionDef>;

export type OptionValues<T extends OptionSchema> = {
  [K in keyof T]: T[K]["type"] extends "string" ? string
    : T[K]["type"] extends "number" ? number
      : T[K]["type"] extends "boolean" ? boolean
        : T[K]["type"] extends "array" ? string[]
          : unknown;
};

abstract class CommandBase<
  TOptions extends OptionSchema = OptionSchema,
  TConfig = OptionValues<TOptions>
> {
  abstract readonly name: string;
  displayName?: string;
  abstract readonly description: string;
  abstract readonly options: TOptions;
  subCommands?: CommandBase[];
  actionLabel?: string;
  buildConfig?(opts: OptionValues<TOptions>): TConfig;
  onConfigChange?(
    key: string,
    value: unknown,
    allValues: Record<string, unknown>,
  ): Record<string, unknown> | undefined;
  abstract execute(config: TConfig): Promise<CommandResult>;
  renderResult?(result: CommandResult): ReactNode;
}

export const Command: typeof CommandBase = runtimeModule.Command;
export const ConfigValidationError: typeof ConfigValidationErrorBase = runtimeModule.ConfigValidationError;
export type AnyCommand = CommandBase<any, any>;

export interface ApplicationHooks {
  onError?: (error: Error) => Promise<void> | void;
}

abstract class TuiApplicationBase {
  constructor(_config: {
    name: string;
    displayName?: string;
    version: string;
    commands?: AnyCommand[];
    logger?: Record<string, unknown>;
  }) {}

  async run(): Promise<void> {}

  async runFromArgs(_argv: string[]): Promise<void> {}

  setHooks(_hooks: ApplicationHooks): void {}
}

class AppContextBase {
  static current = new AppContextBase();

  readonly logger = {
    debug: (..._args: unknown[]) => {},
    error: (..._args: unknown[]) => {},
    info: (..._args: unknown[]) => {},
    setDetailed: (_enabled: boolean) => {},
    setMinLevel: (_level: unknown) => {},
    warn: (..._args: unknown[]) => {},
  };

  private readonly services = new Map<string, unknown>();

  setService<T>(name: string, service: T): void {
    this.services.set(name, service);
  }

  requireService<T>(name: string): T {
    const service = this.services.get(name);
    if (service === undefined) {
      throw new Error(`Service '${name}' not found.`);
    }
    return service as T;
  }

  getConfigDir(): string {
    return "";
  }
}

export const TuiApplication: typeof TuiApplicationBase = runtimeModule.TuiApplication;
export const AppContext: typeof AppContextBase = runtimeModule.AppContext;
