import { chmod, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const OPENSSL_COMMAND = "/usr/bin/openssl";
const CERTIFICATE_DIRECTORY = resolve(import.meta.dir, "..", ".clanky-dev");
const CERTIFICATE_FILENAME = "macos-signing.p12";
const PASSWORD_FILENAME = "macos-signing-password";
const CERTIFICATE_VALIDITY_DAYS = 7305;
const CERTIFICATE_SUBJECT = "/CN=Clanky macOS Signing/O=Clanky";
const SIGNING_IDENTITY = "Clanky macOS Signing";

interface MacOSSigningFiles {
  certificatePath: string;
  passwordPath: string;
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
        SIGNING_IDENTITY,
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

async function ensureMacOSSigningCertificate(): Promise<MacOSSigningFiles> {
  if (process.platform !== "darwin") {
    throw new Error("macOS signing certificate generation is only supported on macOS.");
  }

  const certificatePath = join(CERTIFICATE_DIRECTORY, CERTIFICATE_FILENAME);
  const passwordPath = join(CERTIFICATE_DIRECTORY, PASSWORD_FILENAME);
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

const files = await ensureMacOSSigningCertificate();
console.log(`macOS signing certificate ready at ${files.certificatePath}`);
console.log(`macOS signing password stored at ${files.passwordPath}`);
