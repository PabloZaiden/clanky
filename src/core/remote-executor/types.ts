/**
 * Configuration for the local command executor.
 */

export interface CommandExecutorConfig {
  /** Base working directory */
  directory: string;
  /** Default timeout in milliseconds */
  timeoutMs?: number;
  environment?: Record<string, string>;
}
