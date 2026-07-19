import {
  DEFAULT_LOG_LEVEL,
  LOG_LEVELS,
  VALID_LOG_LEVELS,
  type LogLevelName,
} from "@pablozaiden/webapp/contracts";

export { DEFAULT_LOG_LEVEL, type LogLevelName };

type ClientLogMethod = (...args: unknown[]) => void;

export interface ClientLogger {
  silly: ClientLogMethod;
  trace: ClientLogMethod;
  debug: ClientLogMethod;
  info: ClientLogMethod;
  warn: ClientLogMethod;
  error: ClientLogMethod;
  fatal: ClientLogMethod;
}

let currentLevel: LogLevelName = DEFAULT_LOG_LEVEL;
const clientLoggers = new Map<string, ClientLogger>();

function write(level: LogLevelName, scope: string, args: unknown[]): void {
  if (LOG_LEVELS[level] < LOG_LEVELS[currentLevel]) {
    return;
  }

  const values = [`[${scope}]`, ...args];
  switch (level) {
    case "silly":
    case "debug":
    case "trace":
      console.debug(...values);
      break;
    case "info":
      console.info(...values);
      break;
    case "warn":
      console.warn(...values);
      break;
    case "error":
    case "fatal":
      console.error(...values);
      break;
  }
}

export function createClientLogger(scope: string): ClientLogger {
  const existing = clientLoggers.get(scope);
  if (existing) {
    return existing;
  }

  const logger: ClientLogger = {
    silly: (...args) => write("silly", scope, args),
    trace: (...args) => write("trace", scope, args),
    debug: (...args) => write("debug", scope, args),
    info: (...args) => write("info", scope, args),
    warn: (...args) => write("warn", scope, args),
    error: (...args) => write("error", scope, args),
    fatal: (...args) => write("fatal", scope, args),
  };
  clientLoggers.set(scope, logger);
  return logger;
}

export const clientLog = createClientLogger("clanky-ui");

export function setClientLogLevel(level: LogLevelName): void {
  if (!VALID_LOG_LEVELS.includes(level)) {
    throw new Error(`Invalid log level: ${String(level)}`);
  }
  currentLevel = level;
}
