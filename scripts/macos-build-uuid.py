#!/usr/bin/env python3
"""Assign content-derived Mach-O UUIDs. Immediately re-sign the modified executable."""
import argparse
import hashlib
from pathlib import Path
import struct
import uuid


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def image_ranges(data):
    if data[:4] == b"\xcf\xfa\xed\xfe":
        return [(0, len(data))]
    formats = {
        b"\xca\xfe\xba\xbe": (">", "IIIII"), b"\xbe\xba\xfe\xca": ("<", "IIIII"),
        b"\xca\xfe\xba\xbf": (">", "IIQQII"), b"\xbf\xba\xfe\xca": ("<", "IIQQII"),
    }
    require(data[:4] in formats and len(data) >= 8, "Expected a 64-bit Mach-O executable")
    endian, layout = formats[data[:4]]
    count = struct.unpack_from(endian + "I", data, 4)[0]
    entry_size = struct.calcsize(endian + layout)
    header_end = 8 + count * entry_size
    require(count > 0 and header_end <= len(data), "Invalid universal Mach-O header")
    ranges = []
    for index in range(count):
        _, _, start, size, *_ = struct.unpack_from(endian + layout, data, 8 + index * entry_size)
        require(size >= 32 and header_end <= start <= len(data) - size, "Invalid Mach-O slice range")
        ranges.append((start, size))
    ordered = sorted(ranges)
    require(all(start + size <= following for (start, size), (following, _) in zip(ordered, ordered[1:])),
            "Overlapping Mach-O slices")
    return ranges


def content_uuid(image):
    require(len(image) >= 32 and image[:4] == b"\xcf\xfa\xed\xfe", "Expected a 64-bit Mach-O slice")
    require(struct.unpack_from("<I", image, 12)[0] == 2, "Expected a Mach-O executable")
    count, commands_size = struct.unpack_from("<II", image, 16)
    commands_end = 32 + commands_size
    require(commands_end <= len(image), "Truncated Mach-O load commands")
    offset = 32
    uuid_offset = None
    signature = None
    replacements = []
    for _ in range(count):
        require(offset + 8 <= commands_end, "Truncated Mach-O load command")
        command, size = struct.unpack_from("<II", image, offset)
        require(size >= 8 and offset + size <= commands_end, "Invalid Mach-O load command size")
        if command == 0x1B:  # LC_UUID
            require(size == 24 and uuid_offset is None, "Missing or duplicate Mach-O UUID data")
            uuid_offset = offset + 8
            replacements.append((uuid_offset, 16, bytes(16)))
        elif command == 0x1D:  # LC_CODE_SIGNATURE
            require(size == 16 and signature is None, "Invalid or duplicate Mach-O code signature")
            signature = struct.unpack_from("<II", image, offset + 8)
            replacements.append((offset + 8, 8, bytes(8)))
        elif command == 0x19:  # LC_SEGMENT_64
            require(size >= 72, "Truncated Mach-O segment")
            if bytes(image[offset + 8:offset + 24]).rstrip(b"\0") == b"__LINKEDIT":
                # codesign adjusts these sizes when replacing the excluded signature blob.
                replacements.extend([(offset + 32, 8, bytes(8)), (offset + 48, 8, bytes(8))])
        offset += size
    require(offset == commands_end and uuid_offset is not None, "Missing UUID or invalid Mach-O commands")
    if signature:
        start, size = signature
        require(size > 0 and commands_end <= start <= len(image) - size, "Invalid Mach-O signature range")
        replacements.append((start, size, b""))
    digest = hashlib.sha256()
    cursor = 0
    for start, size, replacement in sorted(replacements):
        require(cursor <= start, "Overlapping Mach-O hash ranges")
        digest.update(image[cursor:start])
        digest.update(replacement)
        cursor = start + size
    digest.update(image[cursor:])
    value = bytearray(digest.digest()[:16])
    value[6] = (value[6] & 0x0F) | 0x80  # UUIDv8: content-derived SHA-256.
    value[8] = (value[8] & 0x3F) | 0x80
    return uuid_offset, bytes(value)


def rewrite_build_uuids(path):
    require(not path.is_symlink(), "Refusing to modify a symlink")
    data = path.read_bytes()
    updates = []
    for start, size in image_ranges(data):
        offset, value = content_uuid(memoryview(data)[start:start + size])
        updates.append((start + offset, value))
    with path.open("r+b") as output:
        for offset, value in updates:
            if data[offset:offset + 16] != value:
                output.seek(offset)
                output.write(value)
    return [str(uuid.UUID(bytes=value)) for _, value in updates]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("executable", type=Path)
    arguments = parser.parse_args()
    for value in rewrite_build_uuids(arguments.executable):
        print(value)


if __name__ == "__main__":
    main()
