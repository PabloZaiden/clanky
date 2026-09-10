const SYSTEMD_BARE_TOKEN = /^[A-Za-z0-9_@%+=:,./-]+$/;

export function systemdToken(value: string, escapeDollar = false): string {
  const escaped = value
    .replaceAll("\\", "\\\\")
    .replaceAll("\"", "\\\"")
    .replaceAll("%", "%%");
  const rendered = escapeDollar
    ? escaped.replaceAll("$", () => "$$")
    : escaped;
  return SYSTEMD_BARE_TOKEN.test(value) ? rendered : `"${rendered}"`;
}
