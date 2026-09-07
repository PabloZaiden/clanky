import { chmod, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const OPENSSL_COMMAND = "/usr/bin/openssl";
const SECURITY_COMMAND = "/usr/bin/security";
const CODESIGN_COMMAND = "/usr/bin/codesign";
const CERTIFICATE_DIRECTORY = resolve(import.meta.dir, "..", ".clanky-dev");
const CERTIFICATE_FILENAME = "macos-signing.p12";
const PASSWORD_FILENAME = "macos-signing-password";
const CERTIFICATE_VALIDITY_DAYS = 7305;
const CERTIFICATE_SUBJECT = "/CN=Clanky macOS Signing/O=Clanky";
const KEYCHAIN_TIMEOUT_SECONDS = "21600";

export const MACOS_SIGNING_IDENTITY = "Clanky macOS Signing";

export interface MacOSSigningFiles {
  certificatePath: string;
  passwordPath: string;
}

export interface MacOSSigningOptions {
  certificatePath?: string;
  passwordPath?: string;
}

function defaultSigningFiles(): MacOSSigningFiles {
  return {
    certificatePath: join(CERTIFICATE_DIRECTORY, CERTIFICATE_FILENAME),
    passwordPath: join(CERTIFICATE_DIRECTORY, PASSWORD_FILENAME),
  };
}

function generatePassword(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function runCommand(
  command: string,
  args: readonly string[],
  description: string,
): Promise<string> {
  const process = Bun.spawn([command, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (exitCode !== 0) {
    const details = stderr.trim() || stdout.trim();
    throw new Error(
      `${description} failed with exit code ${exitCode}${details ? `: ${details}` : "."}`,
    );
  }
  return stdout.trim();
}

async function readUserKeychains(): Promise<string[]> {
  const output = await runCommand(
    SECURITY_COMMAND,
    ["list-keychains", "-d", "user"],
    "Listing the user's macOS keychains",
  );
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => line.replace(/^"|"$/g, ""));
}

async function readPassword(passwordPath: string): Promise<string> {
  const password = (await Bun.file(passwordPath).text()).trim();
  if (!password) {
    throw new Error(`The macOS signing password file is empty: ${passwordPath}`);
  }
  return password;
}

async function createCertificate(
  certificatePath: string,
  passwordPath: string,
): Promise<void> {
  await mkdir(dirname(certificatePath), { recursive: true });
  const temporaryDirectory = await mkdtemp(join(CERTIFICATE_DIRECTORY, ".generation-"));
  const privateKeyPath = join(temporaryDirectory, "private-key.pem");
  const certificatePemPath = join(temporaryDirectory, "certificate.pem");
  const temporaryCertificatePath = join(temporaryDirectory, CERTIFICATE_FILENAME);

  try {
    await runCommand(
      OPENSSL_COMMAND,
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:3072",
        "-sha256",
        "-days",
        String(CERTIFICATE_VALIDITY_DAYS),
        "-nodes",
        "-subj",
        CERTIFICATE_SUBJECT,
        "-addext",
        "basicConstraints=critical,CA:true",
        "-addext",
        "keyUsage=critical,keyCertSign,digitalSignature",
        "-addext",
        "extendedKeyUsage=codeSigning",
        "-keyout",
        privateKeyPath,
        "-out",
        certificatePemPath,
      ],
      "Generating the self-signed macOS certificate",
    );
    await runCommand(
      OPENSSL_COMMAND,
      [
        "pkcs12",
        "-export",
        "-out",
        temporaryCertificatePath,
        "-inkey",
        privateKeyPath,
        "-in",
        certificatePemPath,
        "-name",
        MACOS_SIGNING_IDENTITY,
        "-keypbe",
        "PBE-SHA1-3DES",
        "-certpbe",
        "PBE-SHA1-3DES",
        "-macalg",
        "sha1",
        "-passout",
        `file:${passwordPath}`,
      ],
      "Packaging the macOS signing certificate",
    );
    await rename(temporaryCertificatePath, certificatePath);
    await chmod(certificatePath, 0o600);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

export async function ensureMacOSSigningCertificate(
  options: MacOSSigningOptions = {},
): Promise<MacOSSigningFiles> {
  if (process.platform !== "darwin") {
    throw new Error("macOS signing is only supported on macOS.");
  }
  const defaults = defaultSigningFiles();
  const certificatePath = options.certificatePath ?? defaults.certificatePath;
  const passwordPath = options.passwordPath ?? defaults.passwordPath;
  const certificateExists = await Bun.file(certificatePath).exists();
  const passwordExists = await Bun.file(passwordPath).exists();

  if (certificateExists && passwordExists) {
    await readPassword(passwordPath);
    return { certificatePath, passwordPath };
  }
  if (certificateExists && !passwordExists) {
    throw new Error(
      `The macOS signing certificate exists but its password file is missing: ${passwordPath}`,
    );
  }

  const password = passwordExists
    ? await readPassword(passwordPath)
    : generatePassword();
  await mkdir(dirname(passwordPath), { recursive: true });
  if (!passwordExists) {
    await Bun.write(passwordPath, `${password}\n`);
    await chmod(passwordPath, 0o600);
  }
  await createCertificate(certificatePath, passwordPath);
  return { certificatePath, passwordPath };
}

function generateKeychainPassword(): string {
  return generatePassword();
}

export async function signMacOSBinary(
  binaryPath: string,
  options: MacOSSigningOptions = {},
): Promise<void> {
  const files = await ensureMacOSSigningCertificate(options);
  const certificatePassword = await readPassword(files.passwordPath);
  const keychainPath = join(
    tmpdir(),
    `clanky-signing-${crypto.randomUUID()}.keychain-db`,
  );
  const keychainPassword = generateKeychainPassword();
  let keychainCreated = false;
  let keychainListChanged = false;
  const originalKeychains = await readUserKeychains();

  try {
    await runCommand(
      SECURITY_COMMAND,
      ["create-keychain", "-p", keychainPassword, keychainPath],
      "Creating the temporary macOS signing keychain",
    );
    keychainCreated = true;
    await runCommand(
      SECURITY_COMMAND,
      ["set-keychain-settings", "-lut", KEYCHAIN_TIMEOUT_SECONDS, keychainPath],
      "Configuring the temporary macOS signing keychain",
    );
    await runCommand(
      SECURITY_COMMAND,
      ["unlock-keychain", "-p", keychainPassword, keychainPath],
      "Unlocking the temporary macOS signing keychain",
    );
    await runCommand(
      SECURITY_COMMAND,
      [
        "import",
        files.certificatePath,
        "-k",
        keychainPath,
        "-P",
        certificatePassword,
        "-A",
      ],
      "Importing the macOS signing certificate",
    );
    await runCommand(
      SECURITY_COMMAND,
      [
        "set-key-partition-list",
        "-S",
        "apple-tool:,apple:,codesign:",
        "-s",
        "-k",
        keychainPassword,
        keychainPath,
      ],
      "Allowing codesign to use the macOS signing key",
    );
    await runCommand(
      SECURITY_COMMAND,
      [
        "list-keychains",
        "-d",
        "user",
        "-s",
        ...originalKeychains,
        keychainPath,
      ],
      "Adding the temporary macOS signing keychain to the search list",
    );
    keychainListChanged = true;
    await runCommand(
      CODESIGN_COMMAND,
      [
        "--force",
        "--sign",
        MACOS_SIGNING_IDENTITY,
        "--keychain",
        keychainPath,
        "--timestamp=none",
        binaryPath,
      ],
      "Signing the macOS binary",
    );
  } finally {
    const cleanupErrors: unknown[] = [];
    if (keychainListChanged) {
      try {
        await runCommand(
          SECURITY_COMMAND,
          ["list-keychains", "-d", "user", "-s", ...originalKeychains],
          "Restoring the user's macOS keychain search list",
        );
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (keychainCreated) {
      try {
        await runCommand(
          SECURITY_COMMAND,
          ["delete-keychain", keychainPath],
          "Removing the temporary macOS signing keychain",
        );
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (cleanupErrors.length > 0) {
      throw new Error("Cleaning up the macOS signing resources failed.", {
        cause: cleanupErrors[0],
      });
    }
  }
}
