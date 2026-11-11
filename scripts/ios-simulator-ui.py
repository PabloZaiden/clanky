#!/usr/bin/env python3
"""Inspect and operate Device Hub for manual simulator recordings."""

import argparse
import ctypes as c
import json
import subprocess
import sys
import time
from pathlib import Path


class Point(c.Structure):
    _fields_ = [("x", c.c_double), ("y", c.c_double)]


class Size(c.Structure):
    _fields_ = [("width", c.c_double), ("height", c.c_double)]


class AccessibilityReadError(RuntimeError):
    pass


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="action", required=True)
    inspect = commands.add_parser("inspect")
    inspect.add_argument("--output", required=True, type=Path)
    inspect.add_argument("--depth", type=int, default=8)
    inspect.add_argument("--limit", type=int, default=400)
    inspect.add_argument("--menus", action="store_true")
    press = commands.add_parser("press")
    press.add_argument("path", help="Path from an inspection, e.g. windows/0/1/2")
    press.add_argument("--label", required=True, help="Expected current element label")
    click = commands.add_parser("click")
    click.add_argument("x", type=float)
    click.add_argument("y", type=float)
    typing = commands.add_parser("type")
    typing.add_argument("text", nargs="?", help="Printable ASCII using the simulator's US keyboard layout")
    typing.add_argument("--stdin", action="store_true", help="Read private text from a pipe instead of arguments")
    key = commands.add_parser("key")
    key.add_argument("name", choices=["return", "tab", "escape", "backspace", "a", "c", "u", "pageup", "pagedown"])
    modifiers = key.add_mutually_exclusive_group()
    modifiers.add_argument("--command", action="store_true")
    modifiers.add_argument("--control", action="store_true")
    args = parser.parse_args()
    if args.action == "type":
        if args.stdin:
            if args.text is not None or sys.stdin.isatty():
                parser.error("Use type --stdin with a private pipe and no text argument.")
            args.text = sys.stdin.read()
        elif args.text is None:
            parser.error("Typing requires text or --stdin.")
    if sys.platform != "darwin":
        parser.error("Run this helper on the Mac hosting Device Hub.")
    if args.action == "inspect" and (args.depth < 0 or args.limit < 1):
        parser.error("Inspection depth must be nonnegative and limit positive.")

    pids = subprocess.run(
        ["/usr/bin/pgrep", "-x", "DeviceHub"], capture_output=True, text=True, check=True
    ).stdout.split()
    if len(pids) != 1:
        raise RuntimeError("Exactly one Device Hub process must be running.")
    cf = c.CDLL("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation")
    ax = c.CDLL("/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices")
    cg = c.CDLL("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics")
    pointer = c.c_void_p

    def bind(library, name, result, *parameters):
        function = getattr(library, name)
        function.restype = result
        function.argtypes = list(parameters)
        return function

    string = bind(cf, "CFStringCreateWithCString", pointer, pointer, c.c_char_p, c.c_uint)
    describe = bind(cf, "CFCopyDescription", pointer, pointer)
    type_id = bind(cf, "CFGetTypeID", c.c_ulong, pointer)
    string_type = bind(cf, "CFStringGetTypeID", c.c_ulong)
    get_text = bind(cf, "CFStringGetCString", c.c_bool, pointer, c.c_char_p, c.c_long, c.c_uint)
    release = bind(cf, "CFRelease", None, pointer)
    count = bind(cf, "CFArrayGetCount", c.c_long, pointer)
    at = bind(cf, "CFArrayGetValueAtIndex", pointer, pointer, c.c_long)
    boolean = bind(cf, "CFBooleanGetValue", c.c_bool, pointer)
    trusted = bind(ax, "AXIsProcessTrusted", c.c_bool)
    application = bind(ax, "AXUIElementCreateApplication", pointer, c.c_int)
    copy = bind(ax, "AXUIElementCopyAttributeValue", c.c_int, pointer, pointer, c.POINTER(pointer))
    set_value = bind(ax, "AXUIElementSetAttributeValue", c.c_int, pointer, pointer, pointer)
    perform = bind(ax, "AXUIElementPerformAction", c.c_int, pointer, pointer)
    unpack = bind(ax, "AXValueGetValue", c.c_bool, pointer, c.c_int, pointer)
    timeout = bind(ax, "AXUIElementSetMessagingTimeout", c.c_int, pointer, c.c_float)
    if not trusted():
        raise RuntimeError("Accessibility permission is required; this helper does not grant it.")
    app = application(int(pids[0]))
    timeout(app, 0.5)

    def attribute(element, name):
        name_ref = string(None, name.encode(), 0x08000100)
        value = pointer()
        try:
            error = copy(element, name_ref, c.byref(value))
        finally:
            release(name_ref)
        if error in (-25205, -25212):
            return None
        if error:
            raise AccessibilityReadError(f"Cannot read {name}: Accessibility error {error}")
        return value.value

    def text(value):
        is_string = type_id(value) == string_type()
        description = value if is_string else describe(value)
        buffer = c.create_string_buffer(16384)
        try:
            if not get_text(description, buffer, len(buffer), 0x08000100):
                raise RuntimeError("Accessibility text exceeds the inspection buffer.")
            return buffer.value.decode("utf-8")
        finally:
            if not is_string:
                release(description)

    def children(element, name="AXChildren"):
        values = attribute(element, name)
        if not values:
            return []
        return [at(values, index) for index in range(count(values))]

    labels = ["AXTitle", "AXDescription", "AXValue", "AXIdentifier"]

    def label_values(element):
        return {
            name: text(value)
            for name in labels
            if (value := attribute(element, name)) is not None
        }

    if args.action == "inspect":
        rows = []
        errors = []

        def walk(element, path, depth):
            if len(rows) >= args.limit:
                return
            row = {"path": "/".join(map(str, path))}
            rows.append(row)
            try:
                row.update(label_values(element))
                for name in ["AXRole", "AXPosition", "AXSize"]:
                    value = attribute(element, name)
                    if value:
                        row[name] = text(value)
                if depth < args.depth:
                    for index, child in enumerate(children(element)):
                        walk(child, [*path, index], depth + 1)
            except AccessibilityReadError as error:
                row["error"] = str(error)
                errors.append(row["path"])

        if args.menus:
            menu = attribute(app, "AXMenuBar")
            if not menu:
                raise RuntimeError("Device Hub has no accessible menu bar.")
            walk(menu, ["menu"], 0)
        else:
            for index, window in enumerate(children(app, "AXWindows")):
                walk(window, ["windows", index], 0)
        if not rows:
            raise RuntimeError("No accessible Device Hub windows; open its device canvas first.")
        with args.output.open("x") as output:
            json.dump(rows, output, indent=2)
        print(json.dumps({"elements": len(rows), "errors": errors, "output": str(args.output)}))
        if errors:
            print("Inspection is incomplete; unavailable elements are marked in the JSON.", file=sys.stderr)
            sys.exit(2)
        return

    name = string(None, b"AXFrontmost", 0x08000100)
    error = set_value(app, name, pointer.in_dll(cf, "kCFBooleanTrue"))
    release(name)
    if error:
        raise RuntimeError(f"Cannot focus Device Hub: Accessibility error {error}")
    deadline = time.monotonic() + 3
    while True:
        front = attribute(app, "AXFrontmost")
        if front and boolean(front):
            break
        if time.monotonic() >= deadline:
            raise RuntimeError("Device Hub did not become the foreground application.")
        time.sleep(0.02)

    if args.action == "press":
        root, *components = args.path.split("/")
        if root == "menu":
            element = attribute(app, "AXMenuBar")
        elif root == "windows" and components:
            element = children(app, "AXWindows")[int(components.pop(0))]
        else:
            raise ValueError("Use a windows/ or menu/ path from a current inspection.")
        for component in components:
            element = children(element)[int(component)]
        if args.label not in label_values(element).values():
            raise RuntimeError("Element label changed; inspect the current interface before pressing.")
        action = string(None, b"AXPress", 0x08000100)
        error = perform(element, action)
        release(action)
        if error:
            raise RuntimeError(f"Cannot press element: Accessibility error {error}")
    else:
        if not bind(cg, "CGPreflightPostEventAccess", c.c_bool)():
            raise RuntimeError("Input-event permission is required; this helper does not grant it.")
        post = bind(cg, "CGEventPost", None, c.c_uint, pointer)
        if args.action == "click":
            inside = False
            for window in children(app, "AXWindows"):
                position, size = Point(), Size()
                position_ref, size_ref = attribute(window, "AXPosition"), attribute(window, "AXSize")
                if position_ref and size_ref and unpack(position_ref, 1, c.byref(position)) and unpack(size_ref, 2, c.byref(size)):
                    inside |= position.x <= args.x <= position.x + size.width and position.y <= args.y <= position.y + size.height
            if not inside:
                raise RuntimeError("Click must be inside a Device Hub window.")
            mouse = bind(cg, "CGEventCreateMouseEvent", pointer, pointer, c.c_uint, Point, c.c_uint)
            for kind in [5, 1, 2]:
                event = mouse(None, kind, Point(args.x, args.y), 0)
                post(0, event)
                release(event)
                if kind != 2:
                    time.sleep(0.08)
        else:
            keyboard = bind(cg, "CGEventCreateKeyboardEvent", pointer, pointer, c.c_ushort, c.c_bool)
            unicode = bind(cg, "CGEventKeyboardSetUnicodeString", None, pointer, c.c_ulong, pointer)
            flags = bind(cg, "CGEventSetFlags", None, pointer, c.c_ulonglong)
            event_type = bind(cg, "CGEventSetType", None, pointer, c.c_uint)
            code = {"return": 36, "tab": 48, "escape": 53, "backspace": 51, "a": 0, "c": 8, "u": 32, "pageup": 116, "pagedown": 121}

            def post_key(key_code, down, modifiers, character=None, modifier=False):
                event = keyboard(None, key_code, down)
                try:
                    if modifier:
                        event_type(event, 12)
                    if character is not None:
                        encoded = character.encode("utf-16-le")
                        unicode(event, len(encoded) // 2, c.create_string_buffer(encoded))
                    flags(event, modifiers)
                    post(0, event)
                finally:
                    release(event)

            strokes = []
            if args.action == "type":
                keys = {
                    "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6,
                    "x": 7, "c": 8, "v": 9, "b": 11, "q": 12, "w": 13,
                    "e": 14, "r": 15, "y": 16, "t": 17, "1": 18, "2": 19,
                    "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25,
                    "7": 26, "-": 27, "8": 28, "0": 29, "]": 30, "o": 31,
                    "u": 32, "[": 33, "i": 34, "p": 35, "l": 37, "j": 38,
                    "'": 39, "k": 40, ";": 41, "\\": 42, ",": 43, "/": 44,
                    "n": 45, "m": 46, ".": 47, " ": 49, "`": 50,
                }
                shifted = dict(zip('~!@#$%^&*()_+{}|:"<>?', "`1234567890-=[]\\;',./"))
                for character in args.text:
                    base = shifted.get(character, character.lower())
                    if not character.isascii() or base not in keys:
                        raise ValueError("Typing supports printable US-ASCII only.")
                    strokes.append((character, keys[base], (1 << 17) if character != base else 0))
            else:
                strokes.append((None, code[args.name], (1 << 20) if args.command else (1 << 18) if args.control else 0))
            for character, key_code, modifiers in strokes:
                modifier_key = 55 if modifiers & (1 << 20) else 59 if modifiers & (1 << 18) else 56 if modifiers else None
                try:
                    # The simulator needs modifier transitions, not only character flags.
                    if modifier_key is not None:
                        post_key(modifier_key, True, modifiers, modifier=True)
                    post_key(key_code, True, modifiers, character)
                    post_key(key_code, False, modifiers, character)
                finally:
                    if modifier_key is not None:
                        post_key(modifier_key, False, 0, modifier=True)
                if character is not None:
                    time.sleep(0.08)
    print(json.dumps({"action": args.action, "application": "DeviceHub"}))


if __name__ == "__main__":
    try:
        main()
    except (OSError, RuntimeError, ValueError, IndexError, subprocess.CalledProcessError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
