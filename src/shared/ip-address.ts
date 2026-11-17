import ipaddr = require("ipaddr.js");

export function isPublicIpAddress(address: string): boolean {
  if (!ipaddr.isValid(address)) return false;
  const parsed = ipaddr.process(address);
  if (parsed.kind() === "ipv6" && parsed.toByteArray().slice(0, 12).every(byte => byte === 0)) {
    return false;
  }
  return parsed.range() === "unicast";
}
