import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  dlopen,
  FFIType,
  ptr,
  read,
  type Pointer,
} from "bun:ffi";

const CORE_FOUNDATION_PATH =
  "/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation";
const HISERVICES_PATH =
  "/System/Library/Frameworks/ApplicationServices.framework/Frameworks/HIServices.framework/HIServices";
const CORE_GRAPHICS_PATH =
  "/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics";
const LIB_SYSTEM_PATH = "/usr/lib/libSystem.B.dylib";
const SCREEN_CAPTURE_COMMAND = "/usr/sbin/screencapture";
const RTLD_LAZY = 1;
const PERMISSION_POLL_INTERVAL_MS = 500;
const PERMISSION_WAIT_TIMEOUT_MS = 120_000;
const DIRECT_SCREEN_CAPTURE_TIMEOUT_MS = 120_000;

const PRIVACY_PANES = {
  accessibility:
    "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_Accessibility",
  screenRecording:
    "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_ScreenCapture",
  filesAndFolders:
    "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_FilesAndFolders",
} as const;

const PROTECTED_FOLDERS = [
  { name: "Desktop", directory: "Desktop" },
  { name: "Documents", directory: "Documents" },
  { name: "Downloads", directory: "Downloads" },
] as const;

type NativePointer = Pointer | bigint;

interface NativeLoader {
  dlopen(path: string, flags: number): NativePointer | null;
  dlsym(handle: NativePointer, symbol: string): NativePointer | null;
}

interface MacPermissionNativeApi {
  requestAccessibility(): boolean;
  isAccessibilityTrusted(): boolean;
  requestScreenRecording(): boolean;
  isScreenRecordingAllowed(): boolean;
}

/** Options for the worker-owned macOS permission preflight. */
export interface MacWorkerPermissionPreflightOptions {
  homeDirectory: string;
  output(message: string): void;
}

function isPermissionDenied(error: unknown): boolean {
  return Boolean(
    error
    && typeof error === "object"
    && "code" in error
    && (error.code === "EACCES" || error.code === "EPERM"),
  );
}

function isMissingDirectory(error: unknown): boolean {
  return Boolean(
    error
    && typeof error === "object"
    && "code" in error
    && error.code === "ENOENT",
  );
}

function requirePointer(
  pointer: NativePointer | null,
  description: string,
): NativePointer {
  if (pointer === null || pointer === 0 || pointer === 0n) {
    throw new Error(`macOS returned a null pointer for ${description}.`);
  }
  return pointer;
}

function openNativeLibrary(path: string): NativePointer {
  const loader = dlopen(LIB_SYSTEM_PATH, {
    dlopen: {
      args: [FFIType.cstring, FFIType.int32_t],
      returns: FFIType.ptr,
    },
  });
  return requirePointer(
    loader.symbols.dlopen(path, RTLD_LAZY),
    `the ${path} framework`,
  );
}

function readGlobalPointer(
  loader: NativeLoader,
  handle: NativePointer,
  symbol: string,
): NativePointer {
  const address = requirePointer(
    loader.dlsym(handle, symbol),
    `the ${symbol} symbol`,
  );
  return requirePointer(
    read.ptr(address, 0) as Pointer,
    `the value of ${symbol}`,
  );
}

function createAccessibilityOptions(
  loader: NativeLoader,
  hiservicesHandle: NativePointer,
  coreFoundationHandle: NativePointer,
  createDictionary: (
    allocator: NativePointer | null,
    keys: NativePointer,
    values: NativePointer,
    count: bigint,
    keyCallbacks: NativePointer | null,
    valueCallbacks: NativePointer | null,
  ) => NativePointer | null,
): { dictionary: NativePointer; keys: BigUint64Array; values: BigUint64Array } {
  const key = readGlobalPointer(
    loader,
    hiservicesHandle,
    "kAXTrustedCheckOptionPrompt",
  );
  const value = readGlobalPointer(loader, coreFoundationHandle, "kCFBooleanTrue");
  const keys = new BigUint64Array([BigInt(key)]);
  const values = new BigUint64Array([BigInt(value)]);
  const dictionary = requirePointer(
    createDictionary(null, ptr(keys), ptr(values), 1n, null, null),
    "the Accessibility prompt options",
  );
  return { dictionary, keys, values };
}

function loadNativeApi(): MacPermissionNativeApi {
  const loaderLibrary = dlopen(LIB_SYSTEM_PATH, {
    dlopen: {
      args: [FFIType.cstring, FFIType.int32_t],
      returns: FFIType.ptr,
    },
    dlsym: {
      args: [FFIType.ptr, FFIType.cstring],
      returns: FFIType.ptr,
    },
  });
  const loader: NativeLoader = {
    dlopen: (path, flags) => loaderLibrary.symbols.dlopen(path, flags),
    dlsym: (handle, symbol) => loaderLibrary.symbols.dlsym(handle, symbol),
  };
  const coreFoundationHandle = openNativeLibrary(CORE_FOUNDATION_PATH);
  const hiservicesHandle = openNativeLibrary(HISERVICES_PATH);
  const coreFoundation = dlopen(CORE_FOUNDATION_PATH, {
    CFDictionaryCreate: {
      args: [
        FFIType.ptr,
        FFIType.ptr,
        FFIType.ptr,
        FFIType.i64,
        FFIType.ptr,
        FFIType.ptr,
      ],
      returns: FFIType.ptr,
    },
    CFRelease: {
      args: [FFIType.ptr],
      returns: FFIType.void,
    },
  });
  const hiservices = dlopen(HISERVICES_PATH, {
    AXIsProcessTrustedWithOptions: {
      args: [FFIType.ptr],
      returns: FFIType.uint8_t,
    },
  });
  const coreGraphics = dlopen(CORE_GRAPHICS_PATH, {
    CGPreflightScreenCaptureAccess: {
      args: [],
      returns: FFIType.bool,
    },
    CGRequestScreenCaptureAccess: {
      args: [],
      returns: FFIType.bool,
    },
    CGMainDisplayID: {
      args: [],
      returns: FFIType.uint32_t,
    },
    CGDisplayCreateImage: {
      args: [FFIType.uint32_t],
      returns: FFIType.ptr,
    },
    CGImageRelease: {
      args: [FFIType.ptr],
      returns: FFIType.void,
    },
  });

  return {
    requestAccessibility: () => {
      const options = createAccessibilityOptions(
        loader,
        hiservicesHandle,
        coreFoundationHandle,
        coreFoundation.symbols.CFDictionaryCreate,
      );
      try {
        return hiservices.symbols.AXIsProcessTrustedWithOptions(options.dictionary) !== 0;
      } finally {
        coreFoundation.symbols.CFRelease(options.dictionary);
        void options.keys;
        void options.values;
      }
    },
    isAccessibilityTrusted: () => (
      hiservices.symbols.AXIsProcessTrustedWithOptions(null) !== 0
    ),
    requestScreenRecording: () => {
      coreGraphics.symbols.CGRequestScreenCaptureAccess();
      const image = coreGraphics.symbols.CGDisplayCreateImage(
        coreGraphics.symbols.CGMainDisplayID(),
      );
      if (!image) return false;
      coreGraphics.symbols.CGImageRelease(image);
      return true;
    },
    isScreenRecordingAllowed: () => {
      if (!coreGraphics.symbols.CGPreflightScreenCaptureAccess()) {
        return false;
      }
      const image = coreGraphics.symbols.CGDisplayCreateImage(
        coreGraphics.symbols.CGMainDisplayID(),
      );
      if (!image) return false;
      coreGraphics.symbols.CGImageRelease(image);
      return true;
    },
  };
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

async function waitForPermission(
  name: string,
  isAllowed: () => boolean | Promise<boolean>,
  output: (message: string) => void,
): Promise<void> {
  const deadline = Date.now() + PERMISSION_WAIT_TIMEOUT_MS;
  while (!(await isAllowed())) {
    if (Date.now() >= deadline) {
      throw new Error(
        `${name} permission was not granted before the preflight timed out.`,
      );
    }
    await wait(PERMISSION_POLL_INTERVAL_MS);
  }
  output(`${name}: granted.`);
}

async function openPrivacyPane(pane: string, name: string): Promise<void> {
  const process = Bun.spawn(["open", pane], {
    stdout: "ignore",
    stderr: "pipe",
  });
  const [exitCode, stderr] = await Promise.all([
    process.exited,
    new Response(process.stderr).text(),
  ]);
  if (exitCode !== 0) {
    const details = stderr.trim();
    throw new Error(
      `Unable to open the macOS ${name} privacy settings${details ? `: ${details}` : "."}`,
    );
  }
}

async function requestAccessibility(
  nativeApi: MacPermissionNativeApi,
  output: (message: string) => void,
): Promise<void> {
  if (nativeApi.isAccessibilityTrusted()) {
    output("Accessibility: already granted.");
    return;
  }
  output("Requesting Accessibility permission in macOS...");
  if (nativeApi.requestAccessibility() || nativeApi.isAccessibilityTrusted()) {
    output("Accessibility: granted.");
    return;
  }
  await openPrivacyPane(PRIVACY_PANES.accessibility, "Accessibility");
  output("Approve Clanky in System Settings > Privacy & Security > Accessibility.");
  await waitForPermission("Accessibility", nativeApi.isAccessibilityTrusted, output);
}

async function requestScreenRecording(
  nativeApi: MacPermissionNativeApi,
  output: (message: string) => void,
): Promise<void> {
  const screenRecordingAllowed = nativeApi.isScreenRecordingAllowed();
  output(
    screenRecordingAllowed
      ? "Screen Recording is already granted; checking direct screen/audio capture consent..."
      : "Requesting Screen Recording and direct screen capture permission in macOS...",
  );
  try {
    await runDirectScreenCaptureProbe();
    output("Screen Recording and screen/audio capture consent: granted.");
    return;
  } catch (error) {
    output(`Direct screen capture probe did not complete: ${String(error)}`);
  }
  if (screenRecordingAllowed) {
    output(
      "Screen/audio capture consent was not confirmed; the worker will continue "
        + "without blocking on another permission prompt.",
    );
    return;
  }
  if (nativeApi.requestScreenRecording() || nativeApi.isScreenRecordingAllowed()) {
    output("Screen Recording and direct screen capture: granted.");
    return;
  }
  await openPrivacyPane(
    PRIVACY_PANES.screenRecording,
    "Screen Recording and direct screen capture",
  );
  output(
    "Approve Clanky in System Settings > Privacy & Security > Screen Recording. "
      + "This also enables direct screen capture for full-screen screenshots.",
  );
  await waitForPermission(
    "Screen Recording and direct screen capture",
    nativeApi.isScreenRecordingAllowed,
    output,
  );
}

async function runDirectScreenCaptureProbe(): Promise<void> {
  const outputPath = join(
    tmpdir(),
    `clanky-screen-permission-${crypto.randomUUID()}.png`,
  );
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    const captureProcess = Bun.spawn(
      [
        SCREEN_CAPTURE_COMMAND,
        "-x",
        "-m",
        "-T",
        "0",
        "-t",
        "png",
        outputPath,
      ],
      {
        stdout: "ignore",
        stderr: "pipe",
      },
    );
    let timedOut = false;
    const exitCode = await Promise.race([
      captureProcess.exited,
      new Promise<number>((resolve) => {
        timeoutId = setTimeout(() => {
          timedOut = true;
          try {
            captureProcess.kill();
          } catch {
            // The process may have exited between the timeout and cleanup.
          }
          resolve(124);
        }, DIRECT_SCREEN_CAPTURE_TIMEOUT_MS);
      }),
    ]);
    const stderr = await new Response(captureProcess.stderr).text();
    if (timedOut) {
      throw new Error("macOS screen capture did not finish before the preflight timed out.");
    }
    if (exitCode !== 0) {
      const details = stderr.trim();
      throw new Error(
        `macOS screen capture exited with status ${exitCode}${details ? `: ${details}` : "."}`,
      );
    }
    if (!(await Bun.file(outputPath).exists())) {
      throw new Error("macOS screen capture produced no image.");
    }
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    await rm(outputPath, { force: true });
  }
}

async function probeProtectedDirectory(
  name: string,
  path: string,
  output: (message: string) => void,
): Promise<void> {
  try {
    await readdir(path);
    output(`${name}: access available.`);
    return;
  } catch (error) {
    if (isMissingDirectory(error)) {
      output(`${name}: not present, skipped.`);
      return;
    }
    if (!isPermissionDenied(error)) {
      throw new Error(`Unable to inspect ${name} at ${path}.`, { cause: error });
    }
  }

  output(
    `${name}: access denied. Approve Clanky in System Settings > Privacy & Security > Files & Folders.`,
  );
  await openPrivacyPane(PRIVACY_PANES.filesAndFolders, "Files & Folders");
  await waitForPermission(
    name,
    async () => {
      try {
        await readdir(path);
        return true;
      } catch (error) {
        if (isPermissionDenied(error)) return false;
        if (isMissingDirectory(error)) return true;
        throw new Error(`Unable to inspect ${name} at ${path}.`, { cause: error });
      }
    },
    output,
  );
}

async function runBestEffortPermissionStep(
  name: string,
  step: () => Promise<void>,
  output: (message: string) => void,
): Promise<void> {
  try {
    await step();
  } catch (error) {
    output(`${name}: preflight failed and will not block the worker: ${String(error)}`);
  }
}

export async function runMacWorkerPermissionPreflight(
  options: MacWorkerPermissionPreflightOptions,
): Promise<void> {
  if (process.platform !== "darwin") {
    throw new Error("macOS worker permission preflight requires macOS.");
  }
  let nativeApi: MacPermissionNativeApi;
  try {
    nativeApi = loadNativeApi();
  } catch (error) {
    options.output(
      `macOS worker permission preflight unavailable and will not block the worker: ${String(error)}`,
    );
    return;
  }

  options.output("Running macOS worker permission preflight.");
  await Promise.all([
    runBestEffortPermissionStep(
      "Accessibility",
      () => requestAccessibility(nativeApi, options.output),
      options.output,
    ),
    runBestEffortPermissionStep(
      "Screen Recording and direct screen capture",
      () => requestScreenRecording(nativeApi, options.output),
      options.output,
    ),
    runBestEffortPermissionStep(
      "Files & Folders",
      async () => {
        await Promise.all(PROTECTED_FOLDERS.map((folder) => probeProtectedDirectory(
          folder.name,
          join(options.homeDirectory, folder.directory),
          options.output,
        )));
      },
      options.output,
    ),
  ]);
  options.output("macOS worker permission preflight completed.");
}
