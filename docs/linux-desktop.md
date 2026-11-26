# Linux desktop app

Download the `Clanky-v<version>-linux-x64.AppImage` or
`Clanky-v<version>-linux-arm64.AppImage` for your CPU from the
[stable releases](https://github.com/pablozaiden/clanky/releases) or the
[rolling release](https://github.com/pablozaiden/clanky/releases/tag/latest).
To verify a download, put its `.sha256` file next to it and run
`sha256sum -c <AppImage filename>.sha256`.
Mark the AppImage executable in the file manager and open it. Clanky uses
the system's GTK 3, WebKitGTK 4.1 and FUSE support; the AppImage includes
the frontend and controller, so it does not need a separate Clanky or Bun
installation. Workspace tools and provider configuration are still required
for [local execution](harnesses.md).

## Connections and local controller

Choose **Connect to an API** for an existing controller or
**Connect through collaboration** for an invitation. API authorization opens
your usual browser. The app keeps its settings, web storage, bundled
controller data, and `app-controller.log` separate from a standalone install.
Controller data lives in `$XDG_DATA_HOME/com.clanky.desktop/Controller`
(`~/.local/share/com.clanky.desktop/Controller` by default).

Use **Local Controller > Start Local Controller** to start the included server.
Clanky remembers a successful start and relaunches the controller next time.
**Stop Local Controller** disables startup; **File > Quit** stops the controller
but preserves the preference. **Connect to Local Controller** is available once
the controller is ready. An occupied port is reported, not adopted.

**Local Controller > Network Access** offers:

- **Local Only** (default): listen on `127.0.0.1:49372`.
- **Automatic Remote Access (Tailscale)**: install and sign in to Tailscale and
  enable Serve/HTTPS on the tailnet first. Clanky starts its own foreground
  Serve session on HTTPS port 443 and withdraws it on Stop/Quit. It does not
  replace existing routes or use Funnel.
- **Direct HTTPS**: use a reachable DNS name or IPv4 address with port `49372`.
  This listens on all interfaces. Use **Export Controller Certificate** and
  add that public certificate as a trusted authority in the OS trust store
  used by WebKitGTK. If your default browser uses a separate certificate
  store, import the same certificate there before signing in. Do not bypass
  certificate validation. See
  [managed HTTPS](deployment.md#optional-controller-managed-https) for validity,
  certificate trust and hostname-change requirements.

Before enabling either remote mode, create an owner password using **Initialize
Owner Password**. Existing owners add a password in Account Settings while
using Local Only. Copy the running HTTPS origin with **Copy Remote Link**.
Applying a changed mode restarts a running controller and interrupts its
connections. Localhost passkeys do not carry over to an HTTPS hostname.

## Updates

Choose **File > Update Settings** to select **Stable** or **Latest** (the rolling
channel), then **File > Check for Updates**. The initial channel matches the
downloaded AppImage. A saved choice overrides it. Switching channels does not
reinstall the same build or install an older one. If the selected channel has
no newer build, wait for its next publication.
If **Update Settings** is missing, first update the AppImage in its current
channel or download a newer AppImage manually.
With your approval, Clanky verifies the signature and announced version, stops
the app-owned controller, replaces the AppImage, and restarts.
Keep the AppImage in a location you can write to. The update replaces both
the shell and the controller, not your data or a standalone Clanky install.

## Build and sign

On native x64 or ARM64 Linux, use Bun, Rust 1.94.1 or later, a C compiler and
`pkg-config`. On Ubuntu, install `libwebkit2gtk-4.1-dev`, `libgtk-3-dev`,
`libssl-dev`, `libxdo-dev`, and `squashfs-tools`, then run:

```bash
bun install --frozen-lockfile
bun run build:linux:desktop
```

The AppImage and its checksum are written to `dist/linux-desktop/`. Local
unsigned builds cannot update. To produce signed builds, also install
`minisign`. Generate a dedicated Tauri key with `tauri signer generate`, keep
the private key backed up in protected storage, and supply its public key
as `CLANKY_LINUX_UPDATE_PUBLIC_KEY` and the private key through Tauri's signing
environment. For local signing tests, also supply a positive
`CLANKY_LINUX_UPDATE_BUILD` (one to eight digits); use increasing numbers for
successive test builds. The release workflow supplies its run number
automatically. In GitHub Actions, set `CLANKY_LINUX_UPDATE_PUBLIC_KEY` as a
repository variable and `CLANKY_LINUX_UPDATE_PRIVATE_KEY` and
`CLANKY_LINUX_UPDATE_PRIVATE_KEY_PASSWORD` as protected secrets. Keep the same
public key across both architectures and channels so existing installations
can verify the next release.
