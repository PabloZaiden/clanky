import type { ReactNode } from "react";

export interface CommandResult {
  success: boolean;
  data?: unknown;
  error?: string;
  message?: string;
}

export class ConfigValidationError extends Error {
  constructor(
    message: string,
    public readonly field?: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ConfigValidationError";
  }
}

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

export abstract class Command<
  TOptions extends OptionSchema = OptionSchema,
  TConfig = OptionValues<TOptions>
> {
  abstract readonly name: string;
  displayName?: string;
  abstract readonly description: string;
  abstract readonly options: TOptions;
  subCommands?: Command[];
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

export type AnyCommand = Command<any, any>;

export interface ApplicationHooks {
  onError?: (error: Error) => Promise<void> | void;
}

export class TuiApplication {
  constructor(_config: {
    name: string;
    displayName?: string;
    version: string;
    commands?: AnyCommand[];
    logger?: Record<string, unknown>;
  }) {}

  async run(): Promise<void> {}

  setHooks(_hooks: ApplicationHooks): void {}
}

export class AppContext {
  static current = new AppContext();

  readonly logger = {
    error: (_message: string) => {},
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
}
