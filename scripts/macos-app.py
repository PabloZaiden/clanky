#!/usr/bin/env python3
"""Build on Linux; sign and package artifacts on macOS. No third-party modules."""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import platform
import plistlib
import re
import stat
import struct
import subprocess
import sys
import tarfile
import uuid
import zipfile


SCRIPT = Path(__file__).resolve()
ZIP = "Clanky-macos-arm64.zip"
DOWNLOAD_PART_BYTES = 16 * 1024 * 1024
PARAMETERS = {
    "executionHostKind", "executionHostId", "artifactDirectory", "remoteDirectory",
    "developerDirectory", "signingIdentity", "bundleIdentifier",
}


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def run(*arguments, capture=True, cwd=None):
    result = subprocess.run(
        [str(argument) for argument in arguments], cwd=cwd,
        stdout=subprocess.PIPE if capture else None,
        stderr=subprocess.PIPE if capture else None,
    )
    require(
        result.returncode == 0,
        str(arguments[0]) + " failed: "
        + (result.stderr.decode(errors="replace")[-3000:] if capture else "See command output."),
    )
    return result.stdout


def digest(path, algorithm="sha256"):
    value = hashlib.new(algorithm)
    with Path(path).open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            value.update(block)
    return value.hexdigest()


def read_json(path):
    return json.loads(Path(path).read_text())


def write_json(path, value):
    with Path(path).open("x") as target:
        json.dump(value, target, indent=2)
        target.write("\n")


def absolute(value, local=True):
    require(isinstance(value, str) and Path(value).is_absolute(), "Expected an absolute path")
    path = Path(value)
    require(".." not in path.parts and len(path.parts) > 2, "Unsafe artifact path")
    if local:
        require(not any(item.is_symlink() for item in [path, *path.parents]), "Symlink in artifact path")
    return path


def config_at(path):
    config = read_json(path)
    require(isinstance(config, dict) and set(config) == PARAMETERS, "Unexpected configuration fields")
    require(all(isinstance(value, str) and value.strip() for value in config.values()), "Missing parameter")
    for key in ["artifactDirectory", "remoteDirectory", "developerDirectory"]:
        host = "linux" if key == "artifactDirectory" else "darwin"
        absolute(config[key], local=sys.platform == host)
    require(config["executionHostKind"] in ["local", "mesh"], "Invalid executionHostKind")
    require(re.fullmatch(r"[0-9A-Fa-f]{40}", config["signingIdentity"]), "Invalid signingIdentity")
    require(re.fullmatch(r"[A-Za-z0-9.-]+", config["bundleIdentifier"]), "Invalid bundleIdentifier")
    return config


def configuration_digest(config):
    return hashlib.sha256(json.dumps(config, sort_keys=True).encode()).hexdigest()


def work_at(config, path, remote=False):
    work = absolute(str(path))
    root = Path(config["remoteDirectory"] if remote else config["artifactDirectory"])
    require(
        work.parent == root and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,100}", work.name),
        "Work must be a named direct child of the configured artifact directory",
    )
    return work


def os_version(value):
    require(isinstance(value, str) and re.fullmatch(r"\d+\.\d+(?:\.\d+)?", value), "Invalid OS version")
    return tuple((list(map(int, value.split("."))) + [0])[:3])


def executable_info(source):
    header = source.read(32)
    require(len(header) == 32, "Truncated Mach-O header")
    magic, cpu, _, kind, count, size, _, _ = struct.unpack("<8I", header)
    require(magic == 0xFEEDFACF and cpu == 0x100000C and kind == 2, "Expected an arm64 Mach-O executable")
    require(0 < count < 1000 and 0 < size <= 1024 * 1024, "Invalid Mach-O load commands")
    commands = source.read(size)
    require(len(commands) == size, "Truncated Mach-O load commands")
    offset, minimum = 0, None
    for _ in range(count):
        require(offset + 8 <= size, "Invalid Mach-O command")
        command, length = struct.unpack_from("<2I", commands, offset)
        require(length >= 8 and offset + length <= size, "Invalid Mach-O command length")
        if command == 0x32:
            require(length >= 24, "Invalid build-version command")
            target, minimum, _ = struct.unpack_from("<3I", commands, offset + 8)
            require(target == 1, "Executable is not built for macOS")
        elif command == 0x24:
            require(length >= 16, "Invalid macOS-version command")
            minimum = struct.unpack_from("<I", commands, offset + 8)[0]
        offset += length
    require(offset == size and minimum is not None, "Missing macOS platform/version")
    return {"architecture": "arm64", "platform": "macOS", "minimumOS": [
        minimum >> 16, (minimum >> 8) & 255, minimum & 255,
    ]}


def bundle_info(read, open_file):
    info = plistlib.loads(read("Clanky.app/Contents/Info.plist"))
    require(info["CFBundleExecutable"] == "Clanky", "Unexpected app executable")
    require(info["CFBundleIconFile"] == "AppIcon", "Missing native icon metadata")
    require(read("Clanky.app/Contents/Resources/AppIcon.icns")[:4] == b"icns", "Missing native icon")
    require(read("Clanky.app/Contents/Resources/Web/index.html"), "Missing bundled frontend")
    binaries = {}
    for name in ["MacOS/Clanky", "Helpers/clanky"]:
        with open_file("Clanky.app/Contents/" + name) as source:
            binaries[name] = executable_info(source)
    minimum = os_version(info["LSMinimumSystemVersion"])
    require(tuple(binaries["MacOS/Clanky"]["minimumOS"]) == minimum, "App minimum OS differs from its plist")
    require(tuple(binaries["Helpers/clanky"]["minimumOS"]) <= minimum, "Controller requires a newer OS than the app")
    return {
        "bundleIdentifier": info["CFBundleIdentifier"], "bundleVersion": info["CFBundleVersion"],
        "marketingVersion": info["CFBundleShortVersionString"],
        "minimumOS": info["LSMinimumSystemVersion"], "executables": binaries,
    }


def app_info(app):
    parent = app.parent
    return bundle_info(lambda name: (parent / name).read_bytes(), lambda name: (parent / name).open("rb"))


def archive_members(entries):
    nodes = {}
    for raw, kind, link in entries:
        name = PurePosixPath(raw)
        require(raw and "\0" not in raw and "\\" not in raw and not name.is_absolute()
                and all(part not in ("", ".", "..") for part in raw.rstrip("/").split("/"))
                and name.parts[0] == "Clanky.app" and kind in ("file", "directory", "link"),
                "Unsafe app archive member")
        key = str(name)
        require(key not in nodes, "Duplicate app archive member")
        nodes[key] = (kind, link)
    require(nodes, "Empty app archive")
    for key in list(nodes):
        for parent in PurePosixPath(key).parents:
            if str(parent) == ".":
                continue
            require(nodes.setdefault(str(parent), ("directory", None))[0] == "directory",
                    "App archive member has a non-directory parent")
    require(nodes["Clanky.app"][0] == "directory", "App archive root must be a directory")

    def follow(parts, pending, active):
        for part in pending:
            if parts:
                require(nodes["/".join(parts)][0] == "directory", "App archive link traverses a file")
            if part in ("", "."):
                continue
            if part == "..":
                require(len(parts) > 1, "App archive link escapes bundle")
                parts.pop()
                continue
            parts.append(part)
            key = "/".join(parts)
            require(key in nodes, "Dangling app archive link")
            kind, link = nodes[key]
            if kind == "link":
                require(key not in active and isinstance(link, str) and link
                        and "\0" not in link and "\\" not in link and not PurePosixPath(link).is_absolute(),
                        "Unsafe app archive link")
                parts = follow(parts[:-1], link.split("/"), active | {key})
        return parts

    for key, (kind, _) in nodes.items():
        if kind == "link":
            follow([], PurePosixPath(key).parts, set())


def extract_app(archive, payload):
    members = archive.getmembers()
    archive_members([
        (member.name, "link" if member.issym() else "directory" if member.isdir()
         else "file" if member.isfile() else "unsupported", member.linkname)
        for member in members
    ])
    # No member may write through a link; create links only after all regular entries.
    archive.extractall(payload, members=[member for member in members if not member.issym()]
                       + [member for member in members if member.issym()])


def zip_info(path):
    with zipfile.ZipFile(path) as archive:
        entries = []
        for member in archive.infolist():
            mode = stat.S_IFMT(member.external_attr >> 16)
            kind = "link" if mode == stat.S_IFLNK else "directory" if member.is_dir() else "file"
            require(mode in (0, stat.S_IFREG, stat.S_IFDIR, stat.S_IFLNK)
                    and (mode != stat.S_IFDIR or member.is_dir()), "Unexpected signed archive member")
            link = archive.read(member).decode("utf-8") if kind == "link" else None
            entries.append((member.filename, kind, link))
        archive_members(entries)
        for name in ["MacOS/Clanky", "Helpers/clanky"]:
            require(archive.getinfo("Clanky.app/Contents/" + name).external_attr >> 16 & 0o111,
                    "Packaged executable permissions missing")
        return bundle_info(archive.read, archive.open)


def signing_targets(app):
    require(not app.is_symlink() and app.is_dir(), "App bundle root must be a directory, not a link")
    app = app.resolve(strict=True)
    files, bundles = [], []
    magic = {bytes.fromhex(value) for value in [
        "feedface", "cefaedfe", "feedfacf", "cffaedfe", "cafebabe", "bebafeca", "cafebabf", "bfbafeca",
    ]}

    def visit(directory):
        for path in sorted(directory.iterdir()):
            if path.is_symlink():
                link = os.readlink(path)
                require(not Path(link).is_absolute()
                        and Path(os.path.abspath(path.parent / link)).is_relative_to(app)
                        and path.resolve(strict=True).is_relative_to(app),
                        "Unsafe app bundle symlink: " + str(path))
                require(path.is_file() or path.is_dir(), "Unsupported app bundle link")
            elif path.is_dir():
                visit(path)
            elif path.is_file():
                with path.open("rb") as source:
                    if source.read(4) in magic:
                        files.append(path)
            else:
                raise RuntimeError("Unsupported app bundle entry: " + str(path))
        if directory.suffix in (".app", ".framework", ".xpc"):
            bundles.append(directory)

    visit(app)
    executables = set()
    for bundle in bundles:
        framework = bundle.suffix == ".framework"
        info = bundle / ("Resources/Info.plist" if framework else "Contents/Info.plist")
        name = plistlib.loads(info.read_bytes())["CFBundleExecutable"]
        require(isinstance(name, str) and name not in ("", ".", "..") and Path(name).name == name,
                "Invalid bundle executable")
        executable = (bundle / (name if framework else "Contents/MacOS/" + name)).resolve(strict=True)
        require(executable.is_relative_to(bundle) and executable in files, "Missing bundle Mach-O executable")
        executables.add(executable)
    return [path for path in files if path not in executables] + bundles


def sign_bundle(config, work, app):
    sparkle = app / "Contents/Frameworks/Sparkle.framework"
    for index, target in enumerate(signing_targets(app)):
        helper = target != sparkle and target.is_relative_to(sparkle) and (
            target.suffix in (".app", ".xpc") or target.name == "Autoupdate"
        )
        options = []
        expected = None
        if helper:
            # Keep each Sparkle helper's own entitlements, never the host app's media permissions.
            xml = run("codesign", "-d", "--entitlements", "-", "--xml", target)
            expected = plistlib.loads(xml) if xml.strip() else {}
            require(isinstance(expected, dict), "Invalid Sparkle helper entitlements")
            expected.pop("com.apple.security.get-task-allow", None)
            entitlements = work / ("sparkle-" + str(index) + ".entitlements")
            with entitlements.open("xb") as destination:
                plistlib.dump(expected, destination)
            options = ["--options", "runtime", "--entitlements", entitlements]
        elif target.is_relative_to(sparkle):
            options = ["--options", "runtime"]
        run("codesign", "--force", "--sign", config["signingIdentity"], "--timestamp=none", *options, target)
        run("codesign", "--verify", "--strict", "--verbose=2", target)
        prefix = work / ("signer-" + str(index) + "-")
        run("codesign", "-d", "--extract-certificates=" + str(prefix), target)
        require(digest(str(prefix) + "0", "sha1").upper() == config["signingIdentity"].upper(),
                "Actual signing identity mismatch")
        if expected is not None:
            xml = run("codesign", "-d", "--entitlements", "-", "--xml", target)
            require((plistlib.loads(xml) if xml.strip() else {}) == expected,
                    "Sparkle helper entitlements changed")
    run("codesign", "--verify", "--deep", "--strict", "--verbose=2", app)


def signing_identity(config):
    require(sys.platform == "darwin" and platform.machine() == "arm64", "Signing host must be an Apple Silicon Mac")
    run("xcrun", "--find", "vtool")
    identities = run("security", "find-identity", "-v", "-p", "codesigning").decode()
    require(re.search(r"\b" + re.escape(config["signingIdentity"]) + r"\b", identities, re.IGNORECASE),
            "Configured signing identity is not currently usable; do not create or substitute one automatically")


def preflight(config):
    signing_identity(config)
    return {"configurationSHA256": configuration_digest(config), "signingIdentityVerified": True}


def prepare(config, work):
    require(sys.platform == "linux", "Application compilation must run on Linux")
    repository = SCRIPT.parent.parent
    require((repository / "package.json").is_file(), "Run the repository-owned driver")
    require(not run("git", "status", "--porcelain", cwd=repository).strip(), "Source checkout must be clean")
    revision = run("git", "rev-parse", "HEAD", cwd=repository).decode().strip()
    baseline = read_json(work / "preflight.json")
    require(baseline["configurationSHA256"] == configuration_digest(config)
            and baseline["signingIdentityVerified"], "Signing preflight changed or failed")
    require((work / "macos-app.py").read_bytes() == SCRIPT.read_bytes(), "Driver changed; start a fresh run")
    for command in ["build", "test", "build:apple:macos:linux"]:
        run("bun", "run", command, capture=False, cwd=repository)
    app = repository / "dist/apple/macos-linux/Clanky.app"
    info = app_info(app)
    signing_targets(app)
    require(info["bundleIdentifier"] == config["bundleIdentifier"], "App identity differs from configuration")
    archive_path = work / "Clanky.tar.gz"
    with archive_path.open("xb") as destination, tarfile.open(fileobj=destination, mode="w:gz") as archive:
        archive.add(app, arcname="Clanky.app")
    require(run("git", "rev-parse", "HEAD", cwd=repository).decode().strip() == revision
            and not run("git", "status", "--porcelain", cwd=repository).strip(), "Source changed during build")
    return {
        "sourceRevision": revision, "configurationSHA256": configuration_digest(config),
        "driverSHA256": digest(SCRIPT), "bundle": info, "archiveSHA256": digest(archive_path),
        "archiveBytes": archive_path.stat().st_size,
        "validation": "bun run build && bun run test; Linux macOS arm64 app/controller build",
    }


def sign(config, work):
    signing_identity(config)
    build = read_json(work / "build.json")
    require(build["configurationSHA256"] == configuration_digest(config), "Signing parameters changed")
    require(build["driverSHA256"] == digest(SCRIPT), "Signing driver changed")
    archive_path = work / "Clanky.tar.gz"
    require(archive_path.stat().st_size == build["archiveBytes"]
            and digest(archive_path) == build["archiveSHA256"], "App transfer checksum mismatch")
    payload = work / "Payload"
    payload.mkdir()
    with tarfile.open(archive_path, "r:gz") as archive:
        extract_app(archive, payload)
    app = payload / "Clanky.app"
    require(app_info(app) == build["bundle"]
            and build["bundle"]["bundleIdentifier"] == config["bundleIdentifier"], "Transferred bundle changed")
    sign_bundle(config, work, app)
    archive_path = work / ZIP
    require(not archive_path.exists(), "Signed archive already exists; inspect state instead of replaying")
    run("ditto", "-c", "-k", "--keepParent", "--norsrc", app, archive_path)
    require(zip_info(archive_path) == build["bundle"], "Packaged bundle changed")
    return {
        "build": build, "archive": ZIP, "archiveSHA256": digest(archive_path),
        "archiveBytes": archive_path.stat().st_size, "signingIdentity": config["signingIdentity"].upper(),
        "signatureVerified": True, "appExecutionVerified": False, "notarized": False,
    }


def download_parts(signed):
    require(signed["archive"] == ZIP
            and isinstance(signed["archiveBytes"], int) and signed["archiveBytes"] > 0
            and re.fullmatch(r"[0-9a-f]{64}", signed["archiveSHA256"]), "Invalid signed archive metadata")
    for index, start in enumerate(range(0, signed["archiveBytes"], DOWNLOAD_PART_BYTES)):
        end = min(start + DOWNLOAD_PART_BYTES, signed["archiveBytes"]) - 1
        yield ZIP + ".part-" + str(index).zfill(4), start, end


def verify(config, work):
    signed = read_json(work / "signed.json")
    build = read_json(work / "build.json")
    require(signed["build"] == build and build["configurationSHA256"] == configuration_digest(config),
            "Signing receipt differs from this build")
    require(signed["signatureVerified"]
            and signed["signingIdentity"] == config["signingIdentity"].upper()
            and signed["archive"] == ZIP, "Unexpected signing receipt")
    archive_path = work / ZIP
    assembling = work / (ZIP + ".assembling")
    with assembling.open("xb") as target:
        for name, start, end in download_parts(signed):
            part = work / name
            require(part.stat().st_size == end - start + 1, "Downloaded part size mismatch: " + name)
            with part.open("rb") as source:
                for block in iter(lambda: source.read(1024 * 1024), b""):
                    target.write(block)
    require(assembling.stat().st_size == signed["archiveBytes"]
            and digest(assembling) == signed["archiveSHA256"], "Signed download checksum mismatch")
    require(zip_info(assembling) == build["bundle"], "Downloaded bundle differs from signed app")
    os.link(assembling, archive_path)
    assembling.unlink()
    with (work / (ZIP + ".sha256")).open("x") as checksum:
        checksum.write(signed["archiveSHA256"] + "  " + ZIP + "\n")
    return {
        "archive": str(archive_path), "archiveSHA256": signed["archiveSHA256"],
        "sourceRevision": build["sourceRevision"], "signedDownloadVerified": True,
        "appExecutionVerified": False, "notarized": False,
    }


def requests(config, work, stage):
    work.mkdir(parents=True, exist_ok=True)
    frozen = work / "parameters.json"
    if not frozen.exists():
        require(stage == "preflight", "Start with the preflight request stage")
        write_json(frozen, config)
        with (work / "macos-app.py").open("xb") as target:
            target.write(SCRIPT.read_bytes())
        write_json(work / "create-only.json", {"x-clanky-file-conditions": '{"ifNoneMatch":"*"}'})
    require(config_at(frozen) == config and (work / "macos-app.py").read_bytes() == SCRIPT.read_bytes(),
            "Driver or frozen parameters changed; start a fresh run")
    remote = Path(config["remoteDirectory"]) / work.name
    parameters = [{"name": "kind", "value": config["executionHostKind"]},
                  {"name": "id", "value": config["executionHostId"]}]
    steps = []

    def execute(command, arguments, description):
        steps.append({
            "operationId": "POST /api/execution-hosts/:kind/:id/exec",
            "parameters": parameters, "query": [],
            "bodyJson": json.dumps({"command": command, "args": arguments, "timeoutMs": 120000}),
            "confirmationDescription": description,
        })

    def upload(name):
        steps.append({
            "operationId": "PUT /api/execution-hosts/:kind/:id/files/filesystem/content",
            "parameters": parameters, "query": [{"name": "path", "value": str(remote / name)}],
            "bodyJson": None, "bodyFile": {"path": str(work / name), "contentType": "application/octet-stream"},
            "headersFile": {"path": str(work / "create-only.json")},
            "confirmationDescription": "Transfer " + name + " to the signing host without overwriting files.",
        })

    def download(name, destination=None, headers=None):
        step = {
            "operationId": "GET /api/execution-hosts/:kind/:id/files/filesystem/content",
            "parameters": parameters, "query": [{"name": "path", "value": str(remote / name)}],
            "bodyJson": None, "responseFile": {"path": str(work / (destination or name))},
            "confirmationDescription": None,
        }
        if headers:
            step["headersFile"] = {"path": str(work / headers)}
        steps.append(step)

    suffix = "-" + uuid.uuid4().hex[:8] if stage == "status" else ""
    if stage == "preflight":
        execute("/bin/mkdir", ["-p", "-m", "700", config["remoteDirectory"]],
                "Prepare the private artifact directory on the selected Mac.")
        execute("/bin/mkdir", ["-m", "700", str(remote)], "Create a fresh Mac signing run directory.")
        upload("macos-app.py")
        upload("parameters.json")
    elif stage == "sign":
        upload("Clanky.tar.gz")
        upload("build.json")
    if stage == "download":
        signed = read_json(work / "signed.json")
        require(signed["build"]["configurationSHA256"] == configuration_digest(config)
                and signed["signatureVerified"], "Signing receipt does not match this run")
        for name, start, end in download_parts(signed):
            headers = name + ".headers.json"
            write_json(work / headers, {
                "range": "bytes=" + str(start) + "-" + str(end),
                "if-match": '"' + signed["archiveSHA256"] + '"',
            })
            download(ZIP, name, headers)
    else:
        receipt = {"preflight": "preflight.json", "sign": "signed.json",
                   "status": "status" + suffix + ".json"}[stage]
        execute("/usr/bin/python3", [
            str(remote / "macos-app.py"), stage, "--config", str(remote / "parameters.json"),
            "--work", str(remote), "--receipt", str(remote / receipt),
        ], "Run the " + stage + " stage of private Mac app packaging on the selected Mac.")
        download(receipt)
    result = {"stage": stage, "describeBeforeExecution": sorted({step["operationId"] for step in steps}),
              "stopOnPendingOrUnknown": True, "steps": steps}
    write_json(work / (stage + suffix + "-requests.json"), result)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["requests", "preflight", "prepare", "sign", "verify", "status"])
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--work", type=Path, required=True)
    parser.add_argument("--stage", choices=["preflight", "sign", "download", "status"])
    parser.add_argument("--receipt", type=Path)
    arguments = parser.parse_args()
    os.umask(0o077)
    config = config_at(arguments.config)
    remote = sys.platform == "darwin" and arguments.command != "requests"
    work = work_at(config, arguments.work, remote)
    if remote:
        os.environ["DEVELOPER_DIR"] = config["developerDirectory"]
    os.environ["COPYFILE_DISABLE"] = "1"
    if arguments.command == "requests":
        require(arguments.stage is not None, "--stage is required")
        require(arguments.receipt is None, "Request generation does not take --receipt")
        result = requests(config, work, arguments.stage)
    else:
        name = {"preflight": "preflight", "prepare": "build", "sign": "signed",
                "verify": "verified", "status": "status"}[arguments.command] + ".json"
        receipt = arguments.receipt or work / name
        require(receipt.parent == work and not receipt.exists() and not receipt.is_symlink(),
                "Receipt must be a new file in this run; inspect state instead of replaying")
        if arguments.command == "preflight":
            result = preflight(config)
        elif arguments.command == "prepare":
            result = prepare(config, work)
        elif arguments.command == "sign":
            result = sign(config, work)
        elif arguments.command == "verify":
            result = verify(config, work)
        else:
            result = {name: {"exists": (work / name).is_file(),
                             "bytes": (work / name).stat().st_size if (work / name).is_file() else None}
                      for name in ["preflight.json", "build.json", "signed.json", "Clanky.tar.gz", ZIP]}
        write_json(receipt, result)
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
