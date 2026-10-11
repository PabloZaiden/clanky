import { deflateSync } from "node:zlib";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CRC32_TABLE = new Uint32Array(256);

for (let value = 0; value < CRC32_TABLE.length; value += 1) {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) {
    crc = (crc >>> 1) ^ ((crc & 1) === 1 ? 0xedb88320 : 0);
  }
  CRC32_TABLE[value] = crc >>> 0;
}

function pngChunk(type: "IHDR" | "IDAT" | "IEND", data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.byteLength);
  const crcInput = Buffer.concat([typeBytes, data]);
  let crc = 0xffffffff;
  for (const byte of crcInput) {
    crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ byte) & 0xff]!;
  }
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([length, crcInput, checksum]);
}

export function createPng(width: number, height: number): Buffer {
  const rowBytes = width * 4 + 1;
  const pixels = Buffer.alloc(rowBytes * height);
  let seed = 0x12345678;
  for (let y = 0; y < height; y += 1) {
    const rowOffset = y * rowBytes;
    pixels[rowOffset] = 0;
    for (let x = 1; x < rowBytes; x += 1) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      pixels[rowOffset + x] = seed >>> 24;
    }
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(pixels, { level: 0 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}
