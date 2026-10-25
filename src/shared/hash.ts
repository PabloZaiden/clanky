/**
 * Synchronous, host-independent SHA-256 for representation and cursor identity.
 */

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { utf8Bytes } from "./encoding";

export function sha256Text(value: string): string {
  return bytesToHex(sha256(utf8Bytes(value)));
}
