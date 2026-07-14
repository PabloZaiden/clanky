import type { ProvisioningStep } from "@/shared";
import { DomainError, type DomainErrorOptions } from "../domain-error";

export class ProvisioningFailedError extends DomainError<string> {
  constructor(
    override readonly code: string,
    readonly step: ProvisioningStep,
    message: string,
    options: DomainErrorOptions = {},
  ) {
    super(code, message, {
      ...options,
      details: {
        ...options.details,
        step,
      },
    });
    this.name = "ProvisioningFailedError";
  }
}

export class ProvisioningCancelledError extends DomainError<"provisioning_cancelled"> {
  constructor(message = "Provisioning job was cancelled", options: DomainErrorOptions = {}) {
    super("provisioning_cancelled", message, options);
    this.name = "ProvisioningCancelledError";
  }
}
