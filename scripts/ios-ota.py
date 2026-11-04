#!/usr/bin/env python3
"""Prepare on Linux; sign, serve and publish on macOS. No third-party modules."""
import argparse
import contextlib
import datetime
import fcntl
import fnmatch
import hashlib
import html
import http.server
import ipaddress
import json
import os
from pathlib import Path
import plistlib
import re
import shutil
import signal
import ssl
import subprocess
import sys
import tarfile
import tempfile
import threading
import time
import urllib.parse
import urllib.request
import uuid
import zipfile


PARAMETERS = {
    "executionHostKind", "executionHostId", "artifactDirectory", "remoteDirectory",
    "developerDirectory", "signingIdentity", "provisioningProfile", "bundleIdentifier",
    "teamIdentifier", "deviceIds", "serviceDirectory", "serviceLabel", "bindAddress",
    "installerURL", "bootstrapURL", "rootCertificateName", "rootCertificateSHA256",
}
RELEASE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,100}")
SCRIPT = Path(__file__).resolve()


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def run(*args, capture=True, cwd=None):
    result = subprocess.run(
        [str(arg) for arg in args], cwd=cwd,
        stdout=subprocess.PIPE if capture else None,
        stderr=subprocess.PIPE if capture else None,
    )
    if result.returncode:
        detail = result.stderr.decode(errors="replace")[-2000:] if capture else "See command output above."
        raise RuntimeError(str(args[0]) + " failed (" + str(result.returncode) + "): " + detail)
    return result.stdout if capture else None


def digest(path, algorithm="sha256"):
    value = hashlib.new(algorithm)
    with Path(path).open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            value.update(block)
    return value.hexdigest()


def read_json(path):
    return json.loads(Path(path).read_text())


def write_json(path, value, replace=False):
    write_bytes(path, (json.dumps(value, indent=2) + "\n").encode(), replace)


def write_bytes(path, value, replace=False):
    path = Path(path)
    require(not path.is_symlink(), "Refusing symlink: " + str(path))
    if not replace:
        with path.open("xb") as target:
            target.write(value)
        return
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as target:
        temporary = Path(target.name)
        try:
            target.write(value)
            target.flush()
            os.fsync(target.fileno())
            os.replace(temporary, path)
        finally:
            if temporary.exists():
                temporary.unlink()


def absolute(value, label):
    require(isinstance(value, str) and Path(value).is_absolute(), label + " must be absolute")
    path = Path(value)
    require(".." not in path.parts and len(path.parts) > 2, "Unsafe " + label)
    require(not any(item.is_symlink() for item in [path, *path.parents]),
            "Symlink in " + label)
    return path


def config_at(path):
    config = read_json(path)
    require(isinstance(config, dict) and set(config) == PARAMETERS, "Unexpected configuration fields")
    for key in PARAMETERS - {"deviceIds", "rootCertificateSHA256"}:
        require(isinstance(config[key], str) and config[key].strip(), "Missing parameter: " + key)
    for key in [
        "artifactDirectory", "remoteDirectory", "developerDirectory",
        "provisioningProfile", "serviceDirectory",
    ]:
        absolute(config[key], key)
    require(config["executionHostKind"] in ["local", "mesh"], "Invalid executionHostKind")
    require(re.fullmatch(r"[0-9A-Fa-f]{40}", config["signingIdentity"]), "Invalid signingIdentity")
    require(re.fullmatch(r"[A-Za-z0-9.-]+", config["bundleIdentifier"]), "Invalid bundleIdentifier")
    require(re.fullmatch(r"[A-Za-z0-9.-]+", config["serviceLabel"]), "Invalid serviceLabel")
    require(re.fullmatch(r"[A-Za-z0-9]+", config["teamIdentifier"]), "Invalid teamIdentifier")
    devices = config["deviceIds"]
    require(
        isinstance(devices, list) and devices
        and all(isinstance(item, str) and re.fullmatch(r"[A-Za-z0-9-]+", item) for item in devices)
        and len(set(devices)) == len(devices), "Invalid deviceIds",
    )
    fingerprint = config["rootCertificateSHA256"]
    require(
        fingerprint is None or isinstance(fingerprint, str)
        and re.fullmatch(r"[0-9a-fA-F]{64}", fingerprint), "Invalid rootCertificateSHA256",
    )
    require(ipaddress.ip_address(config["bindAddress"]).version == 4, "An IPv4 bindAddress is required")
    for key, scheme in [("installerURL", "https"), ("bootstrapURL", "http")]:
        url = urllib.parse.urlsplit(config[key])
        require(
            url.scheme == scheme and url.hostname == config["bindAddress"]
            and url.path in ["", "/"] and not url.query and not url.fragment
            and not url.username and not url.password, "Invalid " + key,
        )
        config[key] = config[key].rstrip("/")
    require(
        (urllib.parse.urlsplit(config["installerURL"]).port or 443)
        != (urllib.parse.urlsplit(config["bootstrapURL"]).port or 80), "Installer ports must differ",
    )
    return config


def configuration_digest(config):
    return hashlib.sha256(json.dumps(config, sort_keys=True).encode()).hexdigest()


def version(value):
    require(isinstance(value, str) and re.fullmatch(r"[1-9][0-9]{0,3}", value),
            "Expected an integer CFBundleVersion between 1 and 9999")
    return int(value)


def paths(config):
    service = Path(config["serviceDirectory"])
    require(not service.is_symlink(), "Service directory must not be a symlink")
    return service, absolute(str(service / "public"), "public directory"), absolute(str(service / "tls"), "TLS directory")


def bundle_info(ipa):
    with zipfile.ZipFile(ipa) as archive:
        require(
            all(name.startswith("Payload/Clanky.app/") or name in ["Payload/", "Payload/Clanky.app/"]
                for name in archive.namelist()), "Unexpected IPA layout",
        )
        info = plistlib.loads(archive.read("Payload/Clanky.app/Info.plist"))
        version(info["CFBundleVersion"])
        require(info["CFBundleSupportedPlatforms"] == ["iPhoneOS"], "Not a device IPA")
        return info


def artifact(ipa):
    info = bundle_info(ipa)
    return {
        "bundleIdentifier": info["CFBundleIdentifier"],
        "bundleVersion": info["CFBundleVersion"],
        "marketingVersion": info["CFBundleShortVersionString"],
        "ipaSHA256": digest(ipa),
        "ipaBytes": ipa.stat().st_size,
    }


def release_path(config, identifier):
    require(isinstance(identifier, str) and RELEASE.fullmatch(identifier), "Invalid release identifier")
    service, _, _ = paths(config)
    path = absolute(str(service / "releases" / identifier), "release directory")
    require(not path.is_symlink(), "Release directory is a symlink")
    return path


def current(config):
    service, public, _ = paths(config)
    pointer = service / "current.json"
    if pointer.exists():
        record = read_json(pointer)
        selected = release_path(config, record["release"])
        require(read_json(selected / "release.json") == record, "Release pointer mismatch")
        require(artifact(selected / "Clanky.ipa") == record["artifact"], "Published IPA changed")
        return record
    legacy = public / "Clanky.ipa"
    if legacy.exists():
        metadata = artifact(legacy)
        manifest = plistlib.loads((public / "manifest.plist").read_bytes())["items"][0]
        require(
            manifest["metadata"]["bundle-identifier"] == metadata["bundleIdentifier"]
            and manifest["metadata"]["bundle-version"] == metadata["bundleVersion"],
            "Existing manifest and IPA disagree",
        )
        return {"release": None, "artifact": metadata}
    require(not (public / "manifest.plist").exists(), "Partial existing installer")
    return None


def profile_at(config):
    profile = plistlib.loads(run("security", "cms", "-D", "-i", config["provisioningProfile"]))
    entitlements = profile["Entitlements"]
    application = entitlements["application-identifier"]
    require(profile["ExpirationDate"] > datetime.datetime.utcnow(), "Provisioning profile expired")
    require(
        sorted(profile.get("ProvisionedDevices", [])) == sorted(config["deviceIds"])
        and not profile.get("ProvisionsAllDevices"), "Profile authorizes unexpected devices",
    )
    require(entitlements.get("get-task-allow") is False, "An Ad Hoc distribution profile is required")
    require(
        application.endswith("." + config["bundleIdentifier"])
        and "*" not in application, "Profile does not authorize the exact app identifier",
    )
    require(
        entitlements["com.apple.developer.team-identifier"] == config["teamIdentifier"],
        "Profile team mismatch",
    )
    require(
        any(hashlib.sha1(cert).hexdigest().upper() == config["signingIdentity"].upper()
            for cert in profile["DeveloperCertificates"]), "Signing certificate not authorized",
    )
    require(
        config["signingIdentity"].upper().encode()
        in run("security", "find-identity", "-v", "-p", "codesigning"),
        "Usable Distribution signing identity unavailable",
    )
    require(
        any(fnmatch.fnmatchcase(application, group)
            for group in entitlements["keychain-access-groups"]), "Keychain group not authorized",
    )
    return {
        "application-identifier": application,
        "com.apple.developer.team-identifier": config["teamIdentifier"],
        "keychain-access-groups": [application],
        "get-task-allow": False,
    }


def verify_leaf(config, leaf):
    _, _, tls = paths(config)
    run("openssl", "verify", "-purpose", "sslserver", "-CAfile", tls / "root-ca.pem", leaf)
    certificate = run("openssl", "x509", "-in", leaf, "-noout", "-text").decode()
    require(
        re.search(r"\bIP Address:" + re.escape(config["bindAddress"]) + r"(?=,|\s|$)", certificate),
        "HTTPS certificate does not include the configured IP",
    )


def check_tls(config):
    _, public, tls = paths(config)
    expected = config["rootCertificateSHA256"]
    require(expected is not None, "Pin the root certificate fingerprint before reusing this installer")
    require(digest(public / "clanky-ota-ca.cer").lower() == expected.lower(), "Root CA fingerprint mismatch")
    der = run("openssl", "x509", "-in", tls / "root-ca.pem", "-outform", "DER")
    require(hashlib.sha256(der).hexdigest().lower() == expected.lower(), "Root PEM/DER mismatch")
    verify_leaf(config, tls / "server.pem")
    require(
        (tls / "server-chain.pem").read_bytes()
        == (tls / "server.pem").read_bytes() + (tls / "root-ca.pem").read_bytes(),
        "Served TLS chain differs from verified leaf/root",
    )
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(tls / "server-chain.pem", tls / "server.key")
    return expected.lower()


def service_state(config):
    result = subprocess.run(
        ["launchctl", "print", "gui/" + str(os.getuid()) + "/" + config["serviceLabel"]],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )
    if result.returncode:
        require(b"Could not find service" in result.stderr,
                "Unable to inspect LaunchAgent: " + result.stderr.decode(errors="replace")[-500:])
        return None
    match = re.search(rb"\bstate = ([^\n]+)", result.stdout)
    require(match is not None, "LaunchAgent returned no state")
    return match.group(1).decode().strip()


def service_running(config):
    return service_state(config) == "running"


def preflight(config):
    require(sys.platform == "darwin", "Host operations require macOS")
    profile_at(config)
    service, _, tls = paths(config)
    selected = current(config)
    require(
        selected is None or selected["artifact"]["bundleIdentifier"] == config["bundleIdentifier"],
        "Existing installer has a different app identity",
    )
    fingerprint = check_tls(config) if tls.exists() else None
    require(fingerprint is not None or not selected, "Existing installer has no TLS configuration")
    return {
        "configurationSHA256": configuration_digest(config),
        "current": selected["artifact"] if selected else None,
        "rootCertificateSHA256": fingerprint,
        "needsSetup": not (service / "ios-ota.py").exists()
        or digest(service / "ios-ota.py") != digest(SCRIPT)
        or not (service / "parameters.json").exists()
        or config_at(service / "parameters.json") != config
        or selected is not None and selected["release"] is None,
        "serviceRunning": service_running(config),
        "signingVerified": True,
    }


def work_at(config, work, remote=False):
    root = Path(config["remoteDirectory"] if remote else config["artifactDirectory"])
    work = absolute(str(work), "work directory")
    require(work.parent == root and RELEASE.fullmatch(work.name), "Work must be a named direct child of artifact directory")
    require(not work.is_symlink(), "Work directory is a symlink")
    service = Path(config["serviceDirectory"])
    require(work != service and work not in service.parents and service not in work.parents,
            "Work directory must not overlap the HTTPS service")
    return work


def prepare(config, work):
    require(sys.platform.startswith("linux"), "Application compilation must run on Linux")
    repository = SCRIPT.parent.parent
    require((repository / "package.json").is_file(), "Run the repository-owned script")
    require(not run("git", "status", "--porcelain", cwd=repository).strip(), "Source checkout must be clean")
    revision = run("git", "rev-parse", "HEAD", cwd=repository).decode().strip()
    baseline = read_json(work / "preflight.json")
    require(baseline["configurationSHA256"] == configuration_digest(config), "Preflight configuration changed")
    for command in [
        ["bun", "run", "build"], ["bun", "run", "test"], ["bun", "run", "build:apple:ios:linux"],
    ]:
        run(*command, capture=False, cwd=repository)
    source = repository / "dist/apple/ios-linux/xtool/Clanky.app"
    info = plistlib.loads((source / "Info.plist").read_bytes())
    require(info["CFBundleIdentifier"] == config["bundleIdentifier"], "Source app identity differs from configuration")
    previous = baseline["current"]
    next_build = max(version(info["CFBundleVersion"]), version(previous["bundleVersion"]) if previous else 0) + 1
    version(str(next_build))
    payload = work / "Clanky.app"
    require(not payload.exists(), "Build staging already exists; inspect before retrying")
    shutil.copytree(source, payload)
    info["CFBundleVersion"] = str(next_build)
    write_bytes(payload / "Info.plist", plistlib.dumps(info), replace=True)
    archive_path = work / "Clanky.tar.gz"
    with archive_path.open("xb") as destination, tarfile.open(fileobj=destination, mode="w:gz") as archive:
        archive.add(payload, arcname="Clanky.app")
    require(run("git", "rev-parse", "HEAD", cwd=repository).decode().strip() == revision,
            "Source revision changed during build")
    require(not run("git", "status", "--porcelain", cwd=repository).strip(), "Source changed during build")
    record = {
        "sourceRevision": revision, "configurationSHA256": configuration_digest(config),
        "baseline": previous, "bundleIdentifier": info["CFBundleIdentifier"],
        "bundleVersion": str(next_build), "marketingVersion": info["CFBundleShortVersionString"],
        "archiveSHA256": digest(archive_path), "archiveBytes": archive_path.stat().st_size,
        "validation": "bun run build && bun run test; Linux xtool physical-device build",
    }
    write_json(work / "build.json", record)
    shutil.rmtree(payload)
    return record


def check_baseline(config, build):
    require(build["configurationSHA256"] == configuration_digest(config), "Build configuration changed")
    selected = current(config)
    require((selected["artifact"] if selected else None) == build["baseline"],
            "Published build changed; inspect state and prepare a fresh build")


def sign_app(config, work):
    require(sys.platform == "darwin", "Signing requires macOS")
    build = read_json(work / "build.json")
    check_baseline(config, build)
    entitlements = profile_at(config)
    archive_path = work / "Clanky.tar.gz"
    require(digest(archive_path) == build["archiveSHA256"], "App transfer checksum mismatch")
    payload = work / "Payload"
    payload.mkdir()
    with tarfile.open(archive_path, "r:gz") as archive:
        members = archive.getmembers()
        require(members, "Empty app archive")
        for member in members:
            path = Path(member.name)
            require(
                not path.is_absolute() and ".." not in path.parts
                and path.parts[0] == "Clanky.app" and (member.isfile() or member.isdir()),
                "Unsafe archive member: " + member.name,
            )
        archive.extractall(payload, members=members)
    app = payload / "Clanky.app"
    info = plistlib.loads((app / "Info.plist").read_bytes())
    for key, expected in [
        ("CFBundleIdentifier", build["bundleIdentifier"]), ("CFBundleVersion", build["bundleVersion"]),
        ("CFBundleShortVersionString", build["marketingVersion"]),
    ]:
        require(info[key] == expected, "Bundle metadata changed: " + key)
    require(info["CFBundleIdentifier"] == config["bundleIdentifier"], "App identity changed")
    executable = app / info["CFBundleExecutable"]
    require(executable.parent == app and executable.is_file(), "Unsafe executable path")
    require(b"platform IOS\n" in run("xcrun", "vtool", "-show-build", executable), "Not a physical iOS binary")
    shutil.copyfile(config["provisioningProfile"], app / "embedded.mobileprovision")
    write_bytes(work / "entitlements.plist", plistlib.dumps(entitlements))
    run(
        "codesign", "--force", "--sign", config["signingIdentity"], "--timestamp=none",
        "--entitlements", work / "entitlements.plist", app,
    )
    run("codesign", "--verify", "--strict", "--verbose=2", app)
    actual = plistlib.loads(run("codesign", "-d", "--entitlements", "-", "--xml", app))
    require(actual == entitlements, "Signed entitlements changed")
    run("codesign", "-d", "--extract-certificates=" + str(work / "signer-"), app)
    require(digest(work / "signer-0", "sha1").upper() == config["signingIdentity"].upper(), "Actual signer mismatch")
    ipa = work / "Clanky.ipa"
    require(not ipa.exists(), "Signed IPA already exists")
    run("ditto", "-c", "-k", "--keepParent", "--norsrc", payload, ipa)
    result = {
        "build": build, "artifact": artifact(ipa), "signatureVerified": True,
        "signingIdentity": config["signingIdentity"].upper(), "profileVerified": True,
    }
    with zipfile.ZipFile(ipa) as archive:
        require(
            archive.read("Payload/Clanky.app/embedded.mobileprovision")
            == Path(config["provisioningProfile"]).read_bytes(), "Packaged provisioning profile changed",
        )
    write_json(work / "signed.json", result)
    return result


def page_bytes(config, record):
    base = config["installerURL"]
    if record:
        url = base + "/releases/" + record["release"] + "/manifest.plist"
        install = "itms-services://?action=download-manifest&url=" + urllib.parse.quote(url, safe="")
        metadata = record["artifact"]
        details = 'Version {0}, build {1}.'.format(
            html.escape(metadata["marketingVersion"]), html.escape(metadata["bundleVersion"]),
        )
        button = '<a class="install" href="' + html.escape(install, quote=True) + '">Instalar Clanky</a>'
    else:
        details, button = "No build published yet.", ""
    return ("""<!doctype html><html lang="es"><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Instalar Clanky</title><style>
:root{color-scheme:light dark;font:17px/1.6 system-ui}
body{max-width:620px;margin:32px auto;padding:0 20px}
a,code{overflow-wrap:anywhere}.install{display:inline-block;padding:12px;border:1px solid;border-radius:8px}
</style><h1>Instalar Clanky</h1>
<p>Abri esta pagina con Safari, conectado a la red privada o VPN.</p>
<p><strong>""" + details + """</strong></p><p>""" + button + """</p>
<p>Instala sobre la app existente, sin desinstalarla. Si ya confias en el
certificado, no necesitas instalarlo otra vez.</p>
<details><summary>Configurar confianza por primera vez</summary>
<p><a href="/clanky-ota.mobileconfig">Descargar perfil de confianza</a>.
Instalalo desde Ajustes &gt; General &gt; VPN y gestion de dispositivos.
Luego activa confianza total en Ajustes &gt; General &gt; Informacion &gt;
Ajustes de confianza de certificados para <strong>"""
            + html.escape(config["rootCertificateName"]) + """</strong>.</p>
<p><a href=\"""" + html.escape(base, quote=True) + """/\">Abrir instalador HTTPS</a>.</p>
<p>SHA-256 de la raiz: <code>""" + html.escape(config["rootCertificateSHA256"] or "")
            + """</code>.</p></details></html>""").encode()


def make_release(config, identifier, ipa, revision=None):
    destination = release_path(config, identifier)
    destination.mkdir(parents=True)
    shutil.copyfile(ipa, destination / "Clanky.ipa")
    metadata = artifact(destination / "Clanky.ipa")
    require(metadata["bundleIdentifier"] == config["bundleIdentifier"], "Release app identity mismatch")
    record = {"release": identifier, "artifact": metadata, "sourceRevision": revision}
    package_url = config["installerURL"] + "/releases/" + identifier + "/Clanky.ipa"
    manifest = {"items": [{
        "assets": [{"kind": "software-package", "url": package_url}],
        "metadata": {
            "bundle-identifier": metadata["bundleIdentifier"],
            "bundle-version": metadata["bundleVersion"], "kind": "software", "title": "Clanky",
        },
    }]}
    write_bytes(destination / "manifest.plist", plistlib.dumps(manifest))
    write_bytes(destination / "index.html", page_bytes(config, record))
    write_json(destination / "release.json", record)
    return record


@contextlib.contextmanager
def publication_lock(config):
    service, _, _ = paths(config)
    lock = service / "publication.lock"
    descriptor = os.open(lock, os.O_CREAT | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        os.ftruncate(descriptor, 0)
        os.write(descriptor, (str(os.getpid()) + "\n").encode())
        yield
    finally:
        os.close(descriptor)


def publish(config, work):
    require(sys.platform == "darwin", "Publication requires macOS")
    service, _, _ = paths(config)
    require((service / "ios-ota.py").is_file() and service_running(config), "Run explicit setup before publishing")
    require(
        digest(service / "ios-ota.py") == digest(SCRIPT)
        and config_at(service / "parameters.json") == config, "Installer driver/parameters changed; run explicit setup",
    )
    check_tls(config)
    profile_at(config)
    signed = read_json(work / "signed.json")
    require(signed["signatureVerified"] and signed["profileVerified"], "Signing verification missing")
    require(signed["signingIdentity"] == config["signingIdentity"].upper(), "Signing identity changed")
    run("codesign", "--verify", "--strict", work / "Payload/Clanky.app")
    require(artifact(work / "Clanky.ipa") == signed["artifact"], "Signed IPA changed")
    with publication_lock(config):
        check_baseline(config, signed["build"])
        previous = current(config)
        require(previous is None or previous["release"], "Legacy installer requires explicit setup")
        write_json(work / "rollback.json", {"current": previous})
        record = make_release(
            config, work.name, work / "Clanky.ipa", signed["build"]["sourceRevision"],
        )
        write_json(service / "current.json", record, replace=True)
        result = publication_result(config, record, previous)
        write_json(work / "publication.json", result)
    return result


def publication_result(config, record, previous):
    return {
        **record, "previous": previous, "rootCertificateSHA256": config["rootCertificateSHA256"],
        "installerURL": config["installerURL"] + "/?build=" + record["artifact"]["bundleVersion"],
    }


def reconcile(config, work):
    signed = read_json(work / "signed.json")
    require(signed["build"]["configurationSHA256"] == configuration_digest(config), "Parameters changed")
    selected = current(config)
    require(
        selected is not None and selected["release"] == work.name
        and selected["artifact"] == signed["artifact"]
        and selected["sourceRevision"] == signed["build"]["sourceRevision"],
        "This run is not the current published build; inspect status instead",
    )
    result = publication_result(config, selected, read_json(work / "rollback.json")["current"])
    receipt = work / "publication.json"
    if receipt.exists():
        require(read_json(receipt) == result, "Existing publication receipt disagrees")
    else:
        write_json(receipt, result)
    return result


def rollback(config, work):
    require(sys.platform == "darwin", "Rollback requires macOS")
    service, _, _ = paths(config)
    published = read_json(work / "publication.json")
    previous = read_json(work / "rollback.json")["current"]
    require(previous is not None, "No earlier published build to restore")
    with publication_lock(config):
        selected = current(config)
        require(selected is not None and selected["release"] == published["release"],
                "Installer advanced; refuse stale rollback")
        require(
            artifact(release_path(config, previous["release"]) / "Clanky.ipa") == previous["artifact"],
            "Rollback artifact changed",
        )
        write_json(service / "current.json", previous, replace=True)
        write_json(work / "rolled-back.json", previous)
    return previous


def generate_leaf(config):
    _, _, tls = paths(config)
    leaf = tls / "leaf-request.cnf"
    write_bytes(leaf, (
        "[req]\nprompt=no\ndistinguished_name=dn\n[dn]\nCN=Private iOS installer\n"
        "[server]\nbasicConstraints=critical,CA:FALSE\n"
        "keyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n"
        "subjectAltName=IP:" + config["bindAddress"] + "\n"
        "subjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid,issuer\n"
    ).encode(), replace=True)
    run(
        "openssl", "req", "-new", "-newkey", "rsa:3072", "-nodes", "-sha256",
        "-config", leaf, "-keyout", tls / "server-next.key", "-out", tls / "server.csr",
    )
    run(
        "openssl", "x509", "-req", "-in", tls / "server.csr", "-CA", tls / "root-ca.pem",
        "-CAkey", tls / "root-ca.key", "-set_serial", str(uuid.uuid4().int),
        "-days", "365", "-sha256", "-extfile", leaf, "-extensions", "server",
        "-out", tls / "server-next.pem",
    )
    verify_leaf(config, tls / "server-next.pem")
    for name in ["server.key", "server.pem", "server-chain.pem"]:
        if (tls / name).exists():
            shutil.copyfile(tls / name, tls / (name + ".previous"))
    write_bytes(
        tls / "server-chain.pem",
        (tls / "server-next.pem").read_bytes() + (tls / "root-ca.pem").read_bytes(), replace=True,
    )
    os.replace(tls / "server-next.key", tls / "server.key")
    os.replace(tls / "server-next.pem", tls / "server.pem")


def initialize_ca(config):
    _, public, tls = paths(config)
    require(config["rootCertificateSHA256"] is None, "Never replace an existing pinned root")
    require(not tls.exists(), "TLS directory already exists; refusing root replacement")
    tls.mkdir()
    ca_config = tls / "root-request.cnf"
    require("\n" not in config["rootCertificateName"], "Invalid rootCertificateName")
    write_bytes(ca_config, (
        "[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=ca\n[dn]\nCN="
        + config["rootCertificateName"] + "\n[ca]\nbasicConstraints=critical,CA:TRUE,pathlen:0\n"
        "keyUsage=critical,keyCertSign,cRLSign\nsubjectKeyIdentifier=hash\n"
    ).encode())
    run(
        "openssl", "req", "-x509", "-newkey", "rsa:3072", "-nodes", "-sha256", "-days", "3650",
        "-config", ca_config, "-keyout", tls / "root-ca.key", "-out", tls / "root-ca.pem",
    )
    der = run("openssl", "x509", "-in", tls / "root-ca.pem", "-outform", "DER")
    write_bytes(public / "clanky-ota-ca.cer", der)
    fingerprint = hashlib.sha256(der).hexdigest()
    config["rootCertificateSHA256"] = fingerprint
    identifier = config["serviceLabel"]
    profile = {
        "PayloadContent": [{
            "PayloadContent": der, "PayloadType": "com.apple.security.root", "PayloadVersion": 1,
            "PayloadIdentifier": identifier + ".root", "PayloadUUID": str(uuid.uuid4()).upper(),
            "PayloadDisplayName": config["rootCertificateName"],
        }],
        "PayloadDisplayName": config["rootCertificateName"], "PayloadIdentifier": identifier,
        "PayloadDescription": "Private installer trust root; contains no private key.",
        "PayloadRemovalDisallowed": False, "PayloadType": "Configuration", "PayloadVersion": 1,
        "PayloadUUID": str(uuid.uuid4()).upper(),
    }
    write_bytes(public / "clanky-ota.mobileconfig", plistlib.dumps(profile))
    generate_leaf(config)


def launch_agent(config):
    service, _, _ = paths(config)
    return {
        "Label": config["serviceLabel"], "RunAtLoad": True, "KeepAlive": True,
        "ThrottleInterval": 10, "ProcessType": "Background", "WorkingDirectory": str(service),
        "ProgramArguments": [
            sys.executable, "-u", str(service / "ios-ota.py"), "serve",
            "--config", str(service / "parameters.json"),
        ],
        "StandardOutPath": str(service / "logs/stdout.log"),
        "StandardErrorPath": str(service / "logs/stderr.log"),
    }


def await_service(config, health=True):
    _, _, tls = paths(config)
    context = ssl.create_default_context(cafile=str(tls / "root-ca.pem"))
    deadline = time.monotonic() + 10
    last_error = None
    while time.monotonic() < deadline:
        try:
            endpoint = "/health" if health else "/"
            with urllib.request.urlopen(config["installerURL"] + endpoint, context=context, timeout=1) as response:
                if health:
                    require(read_json_response(response)["service"] == config["serviceLabel"], "Unexpected OTA service")
                else:
                    require(response.status == 200, "Restored installer did not respond")
                return
        except (OSError, ValueError, RuntimeError) as error:
            last_error = error
            time.sleep(0.1)
    raise RuntimeError("Managed HTTPS service did not become ready: " + str(last_error))


def read_json_response(response):
    return json.loads(response.read())


def setup(config, work, initialize=False):
    require(sys.platform == "darwin", "HTTPS setup requires macOS")
    service, public, tls = paths(config)
    service.mkdir(parents=True, exist_ok=True)
    public.mkdir(exist_ok=True)
    (service / "logs").mkdir(exist_ok=True)
    if initialize:
        initialize_ca(config)
    else:
        check_tls(config)
        require((public / "clanky-ota.mobileconfig").is_file(), "Missing existing public trust profile")
    selected = current(config)
    if selected and selected["release"] is None:
        selected = make_release(
            config, "imported-" + selected["artifact"]["bundleVersion"] + "-" + uuid.uuid4().hex[:8],
            public / "Clanky.ipa",
        )
        write_json(service / "current.json", selected)
    agent_path = Path.home() / "Library/LaunchAgents" / (config["serviceLabel"] + ".plist")
    agent_path.parent.mkdir(parents=True, exist_ok=True)
    previous = agent_path.read_bytes() if agent_path.exists() else None
    if previous:
        previous_agent = plistlib.loads(previous)
        require(previous_agent.get("WorkingDirectory") == str(service), "Existing service targets another directory")
    backup = work / "setup-backup"
    backup.mkdir()
    for name in ["ios-ota.py", "parameters.json"]:
        if (service / name).exists():
            shutil.copyfile(service / name, backup / name)
    if previous:
        write_bytes(backup / "launch-agent.plist", previous)
    loaded = service_state(config) is not None
    if loaded:
        run("launchctl", "bootout", "gui/" + str(os.getuid()), agent_path)
    try:
        write_bytes(service / "ios-ota.py", SCRIPT.read_bytes(), replace=True)
        write_json(service / "parameters.json", config, replace=True)
        write_bytes(agent_path, plistlib.dumps(launch_agent(config)), replace=True)
        run("launchctl", "bootstrap", "gui/" + str(os.getuid()), agent_path)
        await_service(config)
    except Exception as error:
        # Restore the previous launch configuration, never the trusted root.
        if service_state(config) is not None:
            run("launchctl", "bootout", "gui/" + str(os.getuid()), agent_path)
        for name in ["ios-ota.py", "parameters.json"]:
            if (backup / name).exists():
                shutil.copyfile(backup / name, service / name)
        if previous:
            write_bytes(agent_path, previous, replace=True)
            if loaded:
                run("launchctl", "bootstrap", "gui/" + str(os.getuid()), agent_path)
                previous_parameters = backup / "parameters.json"
                restored = config_at(previous_parameters) if previous_parameters.exists() else config
                await_service(restored, health=False)
        else:
            agent_path.unlink()
        raise RuntimeError("Setup failed; previous launch configuration restored: " + str(error)) from error
    return {
        "serviceRunning": True, "rootCertificateSHA256": config["rootCertificateSHA256"],
        "installerURL": config["installerURL"], "current": selected, "rootPrivateKeyOnMacOnly": True,
    }


def renew_tls(config):
    require(sys.platform == "darwin", "Certificate renewal requires macOS")
    _, public, tls = paths(config)
    require(config["rootCertificateSHA256"] is not None, "A pinned root certificate is required")
    require(
        digest(public / "clanky-ota-ca.cer").lower() == config["rootCertificateSHA256"].lower(),
        "Existing trusted root changed",
    )
    require((tls / "root-ca.key").is_file(), "Root private key unavailable on signing Mac")
    generate_leaf(config)
    check_tls(config)
    run("launchctl", "kickstart", "-k", "gui/" + str(os.getuid()) + "/" + config["serviceLabel"])
    await_service(config)
    return {"rootCertificateUnchanged": True, "serverCertificateRenewed": True}


def stop_service(config):
    require(sys.platform == "darwin", "Managed service operations require macOS")
    agent_path = Path.home() / "Library/LaunchAgents" / (config["serviceLabel"] + ".plist")
    require(
        plistlib.loads(agent_path.read_bytes()).get("WorkingDirectory") == config["serviceDirectory"],
        "LaunchAgent does not belong to this installer",
    )
    if service_state(config) is not None:
        run("launchctl", "bootout", "gui/" + str(os.getuid()), agent_path)
    return {"serviceStopped": True, "certificatesAndPublishedDataRetained": True}


def serve(config):
    service, public, tls = paths(config)
    check_tls(config)

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_HEAD(self):
            self.respond(True)

        def do_GET(self):
            self.respond(False)

        def respond(self, head):
            path = urllib.parse.urlsplit(self.path).path
            bootstrap = self.server.bootstrap
            if path == "/health" and not bootstrap:
                content = json.dumps({"service": config["serviceLabel"]}).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(content)))
                self.end_headers()
                if not head:
                    self.wfile.write(content)
                return
            ca_files = {
                "/clanky-ota-ca.cer": ("clanky-ota-ca.cer", "application/x-x509-ca-cert"),
                "/clanky-ota.mobileconfig": ("clanky-ota.mobileconfig", "application/x-apple-aspen-config"),
            }
            if path in ca_files:
                name, content_type = ca_files[path]
                source = public / name
            elif bootstrap and path != "/":
                self.send_error(404)
                return
            else:
                if path.startswith("/releases/"):
                    parts = path.split("/")
                    if len(parts) != 4 or not RELEASE.fullmatch(parts[2]):
                        self.send_error(404)
                        return
                    selected = release_path(config, parts[2])
                    name = parts[3]
                else:
                    record = read_json(service / "current.json") if (service / "current.json").exists() else None
                    selected = release_path(config, record["release"]) if record else None
                    name = "index.html" if path == "/" else path.lstrip("/")
                    if path not in ["/", "/manifest.plist", "/Clanky.ipa"]:
                        self.send_error(404)
                        return
                content_type = {
                    "index.html": "text/html; charset=utf-8", "manifest.plist": "application/xml",
                    "Clanky.ipa": "application/octet-stream",
                }.get(name)
                if content_type is None or bootstrap and name != "index.html":
                    self.send_error(404)
                    return
                if selected is None:
                    if path != "/":
                        self.send_error(404)
                        return
                    content = page_bytes(config, None)
                    self.send_response(200)
                    self.send_header("Content-Type", "text/html; charset=utf-8")
                    self.send_header("Content-Length", str(len(content)))
                    self.end_headers()
                    if not head:
                        self.wfile.write(content)
                    return
                source = selected / name
            if source.is_symlink() or not source.is_file():
                self.send_error(404)
                return
            with source.open("rb") as handle:
                size = os.fstat(handle.fileno()).st_size
                start, end = 0, size - 1
                requested = self.headers.get("Range") if not head else None
                if requested:
                    match = re.fullmatch(r"bytes=(\d*)-(\d*)", requested)
                    if not match or not any(match.groups()):
                        self.send_error(416)
                        return
                    first, last = match.groups()
                    start = int(first) if first else max(0, size - int(last))
                    end = min(int(last), size - 1) if first and last else size - 1
                    if size == 0 or start >= size or end < start:
                        self.send_error(416)
                        return
                self.send_response(206 if requested else 200)
                self.send_header("Content-Type", content_type)
                self.send_header("Content-Length", str(end - start + 1))
                self.send_header("Cache-Control", "no-store")
                self.send_header("Accept-Ranges", "bytes")
                self.send_header("X-Content-Type-Options", "nosniff")
                self.send_header("Referrer-Policy", "no-referrer")
                self.send_header(
                    "Content-Security-Policy",
                    "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
                )
                if requested:
                    self.send_header("Content-Range", "bytes %s-%s/%s" % (start, end, size))
                if path in ca_files:
                    self.send_header("Content-Disposition", 'attachment; filename="' + source.name + '"')
                self.end_headers()
                if not head:
                    handle.seek(start)
                    remaining = end - start + 1
                    try:
                        while remaining:
                            block = handle.read(min(131072, remaining))
                            require(block, "Published file truncated")
                            self.wfile.write(block)
                            remaining -= len(block)
                    except (BrokenPipeError, ConnectionResetError) as error:
                        self.log_error("Client disconnected: %s", error)

    servers = []
    try:
        for key, bootstrap in [("bootstrapURL", True), ("installerURL", False)]:
            url = urllib.parse.urlsplit(config[key])
            server = http.server.ThreadingHTTPServer(
                (config["bindAddress"], url.port or (80 if bootstrap else 443)), Handler,
            )
            server.bootstrap = bootstrap
            servers.append(server)
            if not bootstrap:
                context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
                context.minimum_version = ssl.TLSVersion.TLSv1_2
                context.load_cert_chain(tls / "server-chain.pem", tls / "server.key")
                server.socket = context.wrap_socket(server.socket, server_side=True)
        stop = threading.Event()
        for signum in [signal.SIGTERM, signal.SIGINT]:
            signal.signal(signum, lambda *_: stop.set())
        threads = [threading.Thread(target=server.serve_forever) for server in servers]
        for thread in threads:
            thread.start()
        stop.wait()
        for server in servers:
            server.shutdown()
        for thread in threads:
            thread.join()
    finally:
        for server in servers:
            server.server_close()


def requests(config, work, stage, initialize=False):
    work.mkdir(parents=True, exist_ok=True)
    remote = Path(config["remoteDirectory"]) / work.name
    frozen_config = work / "parameters.json"
    if frozen_config.exists():
        require(config_at(frozen_config) == config, "Frozen parameters changed")
    else:
        write_json(frozen_config, config)
        write_bytes(work / "ios-ota.py", SCRIPT.read_bytes())
        write_json(work / "create-only.json", {"x-clanky-file-conditions": '{"ifNoneMatch":"*"}'})
    require(digest(work / "ios-ota.py") == digest(SCRIPT), "Driver changed; start a fresh run")
    parameters = [
        {"name": "kind", "value": config["executionHostKind"]},
        {"name": "id", "value": config["executionHostId"]},
    ]
    steps = []

    def execute(command, arguments, description):
        steps.append({
            "operationId": "POST /api/execution-hosts/:kind/:id/exec",
            "parameters": parameters,
            "query": [{"name": "view", "value": "compact"}, {"name": "maxBytes", "value": "4096"}],
            "bodyJson": json.dumps({"command": command, "args": arguments, "timeoutMs": 60000}),
            "confirmationDescription": description,
        })

    def upload(name):
        steps.append({
            "operationId": "PUT /api/execution-hosts/:kind/:id/files/filesystem/content",
            "parameters": parameters, "query": [{"name": "path", "value": str(remote / name)}],
            "bodyJson": None, "bodyFile": {
                "path": str(work / name),
                "contentType": "application/gzip" if name.endswith(".gz") else "application/octet-stream",
            }, "headersFile": {"path": str(work / "create-only.json")},
            "confirmationDescription": "Transferir " + name + " al host de firma sin sobrescribir archivos.",
        })

    if stage == "preflight":
        execute(
            "/bin/mkdir", ["-p", "-m", "700", config["remoteDirectory"]],
            "Preparar el directorio privado de artefactos en el host seleccionado.",
        )
        execute(
            "/bin/mkdir", ["-m", "700", str(remote)],
            "Crear un directorio nuevo para esta ejecucion, sin reutilizar otro.",
        )
        upload("ios-ota.py")
        upload("parameters.json")
    if stage == "sign":
        upload("Clanky.tar.gz")
        upload("build.json")
    suffix = "-" + uuid.uuid4().hex[:8] if stage == "status" else ""
    receipt = {"sign": "signed", "publish": "publication", "reconcile": "publication"}.get(stage, stage) + suffix + ".json"
    command = [
        str(remote / "ios-ota.py"), stage, "--config", str(remote / "parameters.json"),
        "--work", str(remote), "--receipt", str(remote / receipt),
    ]
    if stage in ["setup", "renew-tls", "publish", "rollback", "cleanup", "stop"]:
        command.extend(["--confirm", stage])
    if initialize:
        require(stage == "setup", "--initialize-ca is only for explicit setup")
        command.append("--initialize-ca")
    execute(
        "/usr/bin/python3", command,
        "Ejecutar la etapa " + stage + " del instalador iOS en el host seleccionado.",
    )
    steps.append({
        "operationId": "GET /api/execution-hosts/:kind/:id/files/filesystem/content",
        "parameters": parameters, "query": [{"name": "path", "value": str(remote / receipt)}],
        "bodyJson": None, "responseFile": {"path": str(work / receipt)}, "confirmationDescription": None,
    })
    result = {
        "stage": stage, "describeBeforeExecution": sorted({step["operationId"] for step in steps}),
        "stopOnPendingOrUnknown": True, "steps": steps,
    }
    write_json(work / (stage + suffix + "-requests.json"), result)
    return result


def verify(config, work):
    published = read_json(work / "publication.json")
    signed = read_json(work / "signed.json")
    require(signed["build"]["configurationSHA256"] == configuration_digest(config), "Verification parameters changed")
    require(published["artifact"] == signed["artifact"], "Publication differs from signed artifact")
    ca = work / "root-ca.cer"
    with urllib.request.urlopen(config["bootstrapURL"] + "/clanky-ota-ca.cer", timeout=10) as response:
        with ca.open("xb") as target:
            shutil.copyfileobj(response, target)
    require(digest(ca).lower() == config["rootCertificateSHA256"].lower(), "Downloaded CA does not match pinned root")
    context = ssl.create_default_context(cadata=ssl.DER_cert_to_PEM_cert(ca.read_bytes()))

    def download(path, destination):
        with urllib.request.urlopen(config["installerURL"] + path, context=context, timeout=30) as response:
            require(response.status == 200, "Download failed: " + path)
            with destination.open("xb") as target:
                shutil.copyfileobj(response, target)

    prefix = "/releases/" + published["release"] + "/"
    download(prefix + "manifest.plist", work / "downloaded-manifest.plist")
    item = plistlib.loads((work / "downloaded-manifest.plist").read_bytes())["items"][0]
    require(
        item["metadata"]["bundle-identifier"] == published["artifact"]["bundleIdentifier"]
        and item["metadata"]["bundle-version"] == published["artifact"]["bundleVersion"]
        and item["assets"] == [{"kind": "software-package", "url": config["installerURL"] + prefix + "Clanky.ipa"}],
        "Manifest differs from published build",
    )
    download(prefix + "Clanky.ipa", work / "downloaded.ipa")
    require(artifact(work / "downloaded.ipa") == signed["artifact"], "Downloaded IPA differs from signed build")
    download("/?build=" + published["artifact"]["bundleVersion"], work / "downloaded-index.html")
    require(
        urllib.parse.quote(config["installerURL"] + prefix + "manifest.plist", safe="")
        in (work / "downloaded-index.html").read_text(), "Installer no longer points to this build",
    )
    result = {
        "artifact": signed["artifact"], "fullTrustedHTTPSDownloadVerified": True,
        "installerURL": published["installerURL"], "phoneInstallationClaimed": False,
    }
    write_json(work / "verified.json", result)
    return result


def cleanup(config, work, remote=False):
    work_at(config, work, remote)
    if remote:
        require((work / "publication.json").is_file(), "Do not clean an unpublished signing run automatically")
        published = read_json(work / "publication.json")
        require(
            artifact(release_path(config, published["release"]) / "Clanky.ipa") == published["artifact"],
            "Published release changed; inspect before cleanup",
        )
    else:
        require((work / "verified.json").is_file(), "Verify full download before cleanup")
    payload = work / "Payload"
    if payload.exists():
        require(not payload.is_symlink(), "Unsafe payload staging")
        shutil.rmtree(payload)
    for name in ["Clanky.tar.gz", "Clanky.ipa", "downloaded.ipa", "entitlements.plist", "signer-0", "signer-1", "signer-2"]:
        target = work / name
        if target.exists():
            require(target.is_file() and not target.is_symlink(), "Unsafe staging file")
            target.unlink()
    return {"temporaryArtifactsCleaned": True, "publishedReleasesAndRollbackRetained": True}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=[
        "requests", "prepare", "preflight", "setup", "renew-tls", "serve", "sign",
        "publish", "rollback", "verify", "cleanup", "status", "stop", "reconcile",
    ])
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--work", type=Path)
    parser.add_argument("--stage", choices=["preflight", "setup", "renew-tls", "sign", "publish", "rollback", "cleanup", "status", "stop", "reconcile"])
    parser.add_argument("--receipt", type=Path)
    parser.add_argument("--initialize-ca", action="store_true")
    parser.add_argument("--confirm")
    args = parser.parse_args()
    os.umask(0o077)
    config = config_at(args.config)
    if sys.platform == "darwin":
        os.environ["DEVELOPER_DIR"] = config["developerDirectory"]
    os.environ["COPYFILE_DISABLE"] = "1"
    if args.command == "serve":
        serve(config)
        return
    require(args.work is not None, "--work is required")
    remote = sys.platform == "darwin" and args.command != "requests"
    work = work_at(config, args.work, remote)
    if args.command in ["setup", "renew-tls", "publish", "rollback", "cleanup", "stop"]:
        require(args.confirm == args.command, "Explicit --confirm " + args.command + " required")
    if args.receipt:
        require(args.receipt.parent == work and not args.receipt.exists(), "Receipt already exists; inspect state instead of replaying")
    if args.command == "requests":
        require(args.stage, "--stage required")
        result = requests(config, work, args.stage, args.initialize_ca)
    elif args.command == "prepare":
        result = prepare(config, work)
    elif args.command == "preflight":
        result = preflight(config)
    elif args.command == "setup":
        result = setup(config, work, args.initialize_ca)
    elif args.command == "renew-tls":
        result = renew_tls(config)
    elif args.command == "stop":
        result = stop_service(config)
    elif args.command == "sign":
        result = sign_app(config, work)
    elif args.command == "publish":
        result = publish(config, work)
    elif args.command == "rollback":
        result = rollback(config, work)
    elif args.command == "reconcile":
        result = reconcile(config, work)
    elif args.command == "verify":
        result = verify(config, work)
    elif args.command == "cleanup":
        result = cleanup(config, work, remote)
    else:
        result = {
            "current": current(config), "serviceRunning": service_running(config),
            "stageFiles": sorted(item.name for item in work.iterdir()),
        }
    if args.receipt and not args.receipt.exists():
        write_json(args.receipt, result)
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, RuntimeError, subprocess.CalledProcessError) as error:
        print("iOS OTA failed: " + str(error), file=sys.stderr)
        sys.exit(1)
