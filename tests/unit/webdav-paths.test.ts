/**
 * Windows URL mapping is an external protocol contract unavailable to the real
 * POSIX-host DAV scenarios. UNC hrefs must not become an authority redirect.
 */

import { expect, test } from "bun:test";
import { davDestination, davHostPath, davHref } from "../../src/cli/webdav/paths";
import type { FileSystemInfo } from "../../src/contracts/schemas/file-system";

const windows: FileSystemInfo = {
  directory: "C:\\workspace", pathStyle: "windows", target: "windows-host", commandExecution: true,
};

test("WebDAV Windows drive and UNC URLs round-trip without changing the endpoint authority", () => {
  for (const path of ["C:\\folder\\file \u00f1%.txt", "\\\\server\\share\\outside\\file.txt"]) {
    const href = davHref(path, "file", "windows");
    const endpoint = new URL(href, "http://127.0.0.1:1234/");
    expect(endpoint.origin).toBe("http://127.0.0.1:1234");
    expect(davHostPath(endpoint.pathname, windows)).toBe(path);
    expect(davDestination(endpoint.toString(), new URL("http://127.0.0.1:1234/C%3A/workspace/"), windows)).toBe(path);
  }
  expect(() => davHostPath("/C%3A/folder%5Cfile", windows)).toThrow();
});
