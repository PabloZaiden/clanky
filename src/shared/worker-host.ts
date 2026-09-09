const WORKER_HOST_PATTERN = /^[A-Za-z0-9._-]+$/;

export function isValidWorkerHostAddress(value: string): boolean {
  const host = value.trim();
  return host.length > 0
    && host.length <= 253
    && WORKER_HOST_PATTERN.test(host);
}
