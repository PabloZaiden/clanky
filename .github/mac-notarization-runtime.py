import atexit
import hashlib
import json
import os
from pathlib import Path
import plistlib
import re
import signal
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request


def command(*args, env=None):
    result = subprocess.run(args, capture_output=True, text=True, env=env)
    if result.returncode:
        raise RuntimeError(f"{args[0]} failed ({result.returncode}): {result.stderr}")
    return result.stdout + result.stderr


def environment(home):
    value = {key: item for key, item in os.environ.items() if not key.startswith("CLANKY_")}
    value.pop("CFFIXED_USER_HOME", None)
    value.update(HOME=str(home))
    return value


def diagnostics(process, *logs):
    pids = ",".join(str(pid) for pid in [process.pid, *descendants(process.pid)])
    sockets = subprocess.run(["lsof", "-nP", "-a", "-p", pids, "-iTCP"], capture_output=True, text=True)
    print("Owned process TCP state:\n" + sockets.stdout, file=sys.stderr)
    for log in logs:
        if not log.exists():
            continue
        lines = []
        for line in log.read_text(errors="replace").splitlines():
            if re.search(r"secret|token|password|authorization|bearer|private.?key", line, re.I):
                lines.append("[credential-related log line omitted]")
            else:
                line = re.sub(r"https?://\S+", "[URL]", line)
                lines.append(re.sub(r"\b[A-Za-z0-9_=-]{24,}\b", "[opaque value]", line))
        print("Sanitized runtime log:\n" + "\n".join(lines[-60:]), file=sys.stderr)


def health(url, process, expected, deadline):
    last = "No health response."
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError(f"Runtime exited with status {process.returncode}; inspect its log.")
        try:
            with urllib.request.urlopen(url, timeout=1) as response:
                data = response.read()
                if response.status == 200 and expected(data):
                    return
                last = f"Unexpected HTTP status or content: {response.status}."
        except (urllib.error.URLError, TimeoutError) as error:
            last = str(error)
        time.sleep(0.1)
    raise RuntimeError(f"{url} did not become ready: {last}")


def descendants(parent):
    rows = command("ps", "-axo", "pid=,ppid=").splitlines()
    pairs = [tuple(map(int, row.split())) for row in rows]
    found = {parent}
    while True:
        children = {pid for pid, ppid in pairs if ppid in found}
        if children <= found:
            return sorted(found - {parent})
        found.update(children)


def stop(process, children):
    if process.poll() is None:
        process.terminate()
        process.wait(timeout=10)
    for pid in children:
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            continue
    deadline = time.monotonic() + 10
    for pid in children:
        while time.monotonic() < deadline:
            status = subprocess.run(["ps", "-o", "stat=", "-p", str(pid)], capture_output=True, text=True)
            if status.returncode == 1 or status.stdout.strip().startswith("Z"):
                break
            if status.returncode:
                raise RuntimeError(f"Cannot inspect owned child {pid}: {status.stderr}")
            time.sleep(0.1)
        else:
            raise RuntimeError(f"Owned child {pid} did not stop.")


def signature(path, expected):
    command("codesign", "--verify", "--strict", str(path))
    details = command("codesign", "-d", "--verbose=4", str(path))
    actual = re.search(r"^CDHash=([a-f0-9]{40})$", details, re.M)
    assert actual and actual.group(1) == expected, f"Signed code changed: {path}"


mode, root, receipt_path = sys.argv[1:]
root = Path(root)
receipt_path = Path(receipt_path)
assert root.is_absolute() and receipt_path.is_absolute()
assert not receipt_path.exists()
work = Path(tempfile.mkdtemp(prefix="clanky-signed-runtime-", dir=os.environ["RUNNER_TEMP"]))
native_owned = []
native_identifier = None


def cleanup():
    try:
        if native_identifier:
            status = subprocess.run(["defaults", "read", native_identifier], capture_output=True)
            if status.returncode == 0:
                command("defaults", "delete", native_identifier)
            elif status.returncode != 1:
                raise RuntimeError("Cannot inspect owned native preferences during cleanup.")
        for path in native_owned:
            if path.is_dir():
                shutil.rmtree(path)
            elif path.exists():
                path.unlink()
        shutil.rmtree(work)
    except (OSError, RuntimeError) as error:
        print(f"Runtime cleanup failed: {error}", file=sys.stderr)
        os._exit(1)


atexit.register(cleanup)
home = work / "home"
home.mkdir(mode=0o700)
result = {"mode": mode, "machine": command("uname", "-m").strip(), "runtime": False}
if mode == "app":
    receipt = json.loads((root / "apple-macos-signing.json").read_text())
    archive = root / "apple-apps/macos/Clanky-macos-arm64-notarized.zip"
    checksum = archive.with_name(archive.name + ".sha256").read_text().split()[0]
    assert hashlib.sha256(archive.read_bytes()).hexdigest() == checksum
    extracted = work / "extracted"
    command("ditto", "-x", "-k", str(archive), str(extracted))
    app = extracted / "Clanky.app"
    original = receipt["artifacts"][0]
    signature(app, receipt["codeDirectoryHashes"][original])
    signature(app / "Contents/Helpers/clanky", receipt["codeDirectoryHashes"][original + "/Contents/Helpers/clanky"])
    command("codesign", "--verify", "--deep", "--strict", str(app))
    command("xcrun", "stapler", "validate", str(app))
    assessment = command("spctl", "--assess", "--type", "execute", "--verbose=2", str(app))
    assert "Notarized Developer ID" in assessment
    info = plistlib.loads((app / "Contents/Info.plist").read_bytes())
    assert os.environ["GITHUB_ACTIONS"] == "true" and os.environ["RUNNER_OS"] == "macOS"
    native_home = Path.home()
    identifier = info["CFBundleIdentifier"]
    assert identifier == "com.clanky.app"
    owned = [
        native_home / "Library/Preferences" / (identifier + ".plist"),
        native_home / "Library/Application Support" / identifier,
        native_home / "Library/WebKit" / identifier,
        native_home / "Library/Caches" / identifier,
        native_home / "Library/Saved Application State" / (identifier + ".savedState"),
    ]
    assert all(not path.exists() for path in owned), "Native validation requires a fresh isolated hosted-runner home."
    native_owned = owned
    native_identifier = identifier
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        asset_port = listener.getsockname()[1]
    command("defaults", "write", identifier, "startLocalControllerOnLaunch", "-bool", "true")
    command("defaults", "write", identifier, "assetServerPort", "-int", str(asset_port))
    assert command("defaults", "read", identifier, "assetServerPort").strip() == str(asset_port)
    env = environment(native_home)
    controller = native_home / "Library/Application Support" / identifier / "Controller"
    with (work / "app.log").open("xb") as log:
        process = subprocess.Popen([str(app / "Contents/MacOS/Clanky")], env=env, stdout=log, stderr=subprocess.STDOUT)
        try:
            deadline = time.monotonic() + 20
            health(f"http://127.0.0.1:{asset_port}/.clanky-health", process, lambda data: len(data) == 36, deadline)
            health("http://127.0.0.1:49372/api/health", process, lambda data: json.loads(data)["ok"] is True, deadline)
            assert (controller / "app-controller.log").is_file(), "Native controller did not use the isolated home."
            with urllib.request.urlopen(f"http://127.0.0.1:{asset_port}/local/", timeout=5) as response:
                assert response.status == 200 and b"<html" in response.read().lower()
            result.update(runtime=True, stapledArchive=True, gatekeeper=True, controller=True, isolatedHome=True)
        except (RuntimeError, AssertionError, OSError, ValueError):
            diagnostics(process, work / "app.log", controller / "app-controller.log")
            raise
        finally:
            stop(process, descendants(process.pid))
else:
    receipt = json.loads((root / "cli-signing.json").read_text())
    target = "arm64" if result["machine"] == "arm64" else "x64"
    matches = list((root / "release-assets").glob(f"clanky-v*-darwin-{target}"))
    assert len(matches) == 1
    binary = matches[0]
    checksum = binary.with_name(binary.name + ".sha256").read_text().split()[0]
    assert hashlib.sha256(binary.read_bytes()).hexdigest() == checksum
    original = next(path for path in receipt["artifacts"] if Path(path).name == binary.name)
    binary.chmod(0o700)
    signature(binary, receipt["codeDirectoryHashes"][original])
    env = environment(home)
    assert command(str(binary), "version", env=env).strip()
    assert "Usage:" in command(str(binary), "--help", env=env)
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
    env = environment(home)
    env.update(CLANKY_DATA_DIR=str(work / "data"), CLANKY_HOST="127.0.0.1",
               CLANKY_PORT=str(port), CLANKY_DISABLE_PASSKEY="true")
    config = json.loads(command(str(binary), "serve", "config", "show", env=env))["effective"]
    assert config["port"] == port and config["host"] == "127.0.0.1"
    with (work / "cli.log").open("xb") as log:
        process = subprocess.Popen([str(binary), "serve"], env=env, stdout=log, stderr=subprocess.STDOUT)
        try:
            health(f"http://127.0.0.1:{port}/api/health", process, lambda data: json.loads(data)["ok"] is True, time.monotonic() + 10)
            for _ in range(100):
                with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/health", timeout=5) as response:
                    assert json.loads(response.read())["ok"] is True
            result.update(runtime=True, architecture=target, checksum=True, signedCodeHash=True, healthRequests=100)
        except (RuntimeError, AssertionError, OSError, ValueError):
            diagnostics(process, work / "cli.log")
            raise
        finally:
            stop(process, descendants(process.pid))
result.update(signingCertificateSHA1=receipt["signingCertificateSHA1"], notarizationSubmissionId=receipt["notarizationSubmissionId"])
receipt_path.write_text(json.dumps(result, indent=2) + "\n")
print(json.dumps(result))
