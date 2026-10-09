let clientId: string | undefined;

export function getClankyClientId(): string {
  clientId ??= crypto.randomUUID();
  return clientId;
}
