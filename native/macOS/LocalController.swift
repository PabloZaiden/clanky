#if os(macOS)
import AppKit
import Foundation
import Security
import SwiftUI

@MainActor
final class LocalController: ObservableObject {
    nonisolated static let port: UInt16 = 49372
    nonisolated static let defaultEndpoint = URL(string: "http://localhost:\(port)")!
    private static let launchPreference = "startLocalControllerOnLaunch"
    private static let tailscalePreference = "localControllerTailscaleEnabled"
    private static let tailscaleURLPreference = "localControllerTailscaleURL"
    @Published private(set) var running = false
    @Published private(set) var busy = false
    @Published private(set) var endpoint = defaultEndpoint
    @Published private(set) var managedHTTPS = false
    @Published private(set) var tailscaleEnabled = false
    @Published private(set) var remoteReady = false
    @Published private(set) var publicEndpoint: URL?
    @Published private(set) var networkStatus = "Local only"
    @Published private(set) var tailscaleConsentURL: URL?
    private(set) var trust: ControllerTlsTrust?
    @Published var error: String?
    @Published private var process: Process?
    private var output: FileHandle?
    private var logURL: URL?
    private var stopRequested = false
    private var restoredLaunchPreference = false
    private var healthEndpoint = defaultEndpoint
    private var tailscaleProcess: Process?
    private var tailscaleInput: FileHandle?
    private var tailscaleOutput: FileHandle?
    private var tailscaleLogURL: URL?
    private var tailscaleMonitor: Task<Void, Never>?
    private var remoteRevision = UUID()
    var hasProcess: Bool { process != nil }
    var canConnect: Bool { running && process?.isRunning == true && (!tailscaleEnabled || remoteReady) }

    private func controllerDirectory() throws -> URL {
        let directory = try FileManager.default.url(
            for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
            .appendingPathComponent(Bundle.main.bundleIdentifier ?? "com.clanky.app")
            .appendingPathComponent("Controller")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        return directory
    }

    private func controllerEnvironment() throws -> [String: String] {
        var environment = ProcessInfo.processInfo.environment.filter { !$0.key.hasPrefix("CLANKY_") }
        environment["CLANKY_DATA_DIR"] = try controllerDirectory().path
        environment["CLANKY_HOST"] = managedHTTPS ? "::" : "127.0.0.1"
        environment["CLANKY_PORT"] = String(Self.port)
        environment["CLANKY_PUBLIC_BASE_URL"] = endpoint.absoluteString
        environment["CLANKY_MANAGED_TLS"] = managedHTTPS ? "true" : "false"
        if tailscaleEnabled {
            environment["CLANKY_TRUST_PROXY"] = "true"
            environment["CLANKY_TRUST_PROXY_HEADERS"] = "proto"
            environment["CLANKY_TRUST_PROXY_CHAIN"] = "first"
        }
        return environment
    }

    private func runCLI(_ arguments: [String], input: String? = nil) async throws -> Data {
        let executable = Bundle.main.bundleURL.appendingPathComponent("Contents/Helpers/clanky")
        guard FileManager.default.isExecutableFile(atPath: executable.path) else {
            throw NSError(domain: "Clanky", code: 2, userInfo: [
                NSLocalizedDescriptionKey: "The bundled Clanky CLI is missing."
            ])
        }
        return try await runNativeCommand(executable, arguments: arguments,
                                          environment: controllerEnvironment(), input: input)
    }

    private func loadConnection() async throws {
        let data = try await runCLI(["controller", "tls", "status"])
        let state = try JSONDecoder().decode(ControllerTlsState.self, from: data)
        if state.enabled {
            guard let url = state.endpoint, url.scheme == "https", url.port == Int(Self.port) else {
                throw NSError(domain: "Clanky", code: 10, userInfo: [
                    NSLocalizedDescriptionKey: "The managed controller must use HTTPS on port \(Self.port)."
                ])
            }
            trust = try ControllerTlsTrust(state: state)
            endpoint = url
            healthEndpoint = url
            publicEndpoint = url
            managedHTTPS = true
            tailscaleEnabled = false
            if !hasProcess { networkStatus = "Direct HTTPS" }
        } else {
            trust = nil
            managedHTTPS = false
            healthEndpoint = Self.defaultEndpoint
            let saved = UserDefaults.standard.object(forKey: Self.tailscalePreference)
            guard saved == nil || saved is Bool else {
                throw LocalControllerFailure(message: "The saved network access preference is invalid.")
            }
            tailscaleEnabled = saved as? Bool ?? false
            if tailscaleEnabled {
                guard let value = UserDefaults.standard.string(forKey: Self.tailscaleURLPreference),
                      let url = URL(string: value), let host = url.host,
                      url == (try Tailscale.httpsURL(host)) else {
                    throw LocalControllerFailure(message: "The saved Tailscale URL is invalid. Apply Network Access again.")
                }
                endpoint = url
                publicEndpoint = url
                if !hasProcess { networkStatus = "Tailscale access is enabled; controller stopped" }
            } else {
                endpoint = Self.defaultEndpoint
                publicEndpoint = nil
                if !hasProcess { networkStatus = "Local only" }
            }
        }
    }

    func refreshConnection() async {
        do { try await loadConnection() }
        catch { self.error = "Unable to load controller configuration: \(error.localizedDescription)" }
    }

    func startIfEnabled() async {
        guard !restoredLaunchPreference else { return }
        restoredLaunchPreference = true
        guard let saved = UserDefaults.standard.object(forKey: Self.launchPreference) else { return }
        guard let enabled = saved as? Bool else {
            error = "The saved local controller launch preference is invalid."
            return
        }
        if enabled { await start() }
    }

    func start() async {
        guard process == nil, !busy else { return }
        busy = true
        error = nil
        defer { busy = false }
        do {
            try await loadConnection()
            if tailscaleEnabled {
                try await requireRemoteCredentials()
                do {
                    let discovered = try await Tailscale.discover(Tailscale.executable())
                    endpoint = discovered
                    publicEndpoint = discovered
                    UserDefaults.standard.set(discovered.absoluteString, forKey: Self.tailscaleURLPreference)
                } catch is CancellationError { throw CancellationError() }
                catch { setNetworkStatus("Remote access unavailable: \(error.localizedDescription)") }
            }
            try ensurePortAvailable()
            let executable = Bundle.main.bundleURL.appendingPathComponent("Contents/Helpers/clanky")
            guard FileManager.default.isExecutableFile(atPath: executable.path) else {
                throw NSError(domain: "Clanky", code: 2, userInfo: [
                    NSLocalizedDescriptionKey: "The bundled Clanky CLI is missing. Build the macOS app with its controller."
                ])
            }
            let directory = try controllerDirectory()
            let log = directory.appendingPathComponent("app-controller.log")
            if !FileManager.default.fileExists(atPath: log.path) {
                guard FileManager.default.createFile(atPath: log.path, contents: nil,
                                                     attributes: [.posixPermissions: 0o600]) else {
                    throw CocoaError(.fileWriteUnknown)
                }
            }
            let handle = try FileHandle(forWritingTo: log)
            try handle.seekToEnd()
            output = handle
            logURL = log
            let child = Process()
            child.executableURL = executable
            child.arguments = ["serve", "--api-only", "true"]
            child.environment = try controllerEnvironment()
            child.currentDirectoryURL = FileManager.default.homeDirectoryForCurrentUser
            child.standardInput = FileHandle.nullDevice
            child.standardOutput = handle
            child.standardError = handle
            child.terminationHandler = { [weak self] child in
                Task { @MainActor in
                    await self?.finish(child)
                }
            }
            stopRequested = false
            try child.run()
            process = child
            let session = URLSession(configuration: .ephemeral, delegate: trust, delegateQueue: nil)
            defer { session.invalidateAndCancel() }
            let deadline = Date().addingTimeInterval(10)
            var lastFailure = "Controller did not become ready."
            while Date() < deadline {
                guard child.isRunning else {
                    throw NSError(domain: "Clanky", code: 4, userInfo: [
                        NSLocalizedDescriptionKey: "The bundled CLI exited with status \(child.terminationStatus)."
                    ])
                }
                do {
                    var request = URLRequest(url: healthEndpoint.appendingPathComponent("api/health"))
                    request.timeoutInterval = 1
                    let (data, response) = try await session.data(for: request)
                    if (response as? HTTPURLResponse)?.statusCode == 200,
                       let health = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                       health["ok"] as? Bool == true, child.isRunning {
                        running = true
                        UserDefaults.standard.set(true, forKey: Self.launchPreference)
                        if tailscaleEnabled {
                            await reconcileTailscale(allowBusy: true)
                            startTailscaleMonitor()
                        } else { remoteReady = managedHTTPS }
                        return
                    }
                    lastFailure = "Controller health check did not succeed."
                } catch {
                    lastFailure = error.localizedDescription
                }
                try await Task.sleep(for: .milliseconds(100))
            }
            throw NSError(domain: "Clanky", code: 3, userInfo: [NSLocalizedDescriptionKey: lastFailure])
        } catch {
            let message = error.localizedDescription
            await stop()
            self.error = "Unable to start the local controller: \(message)"
                + (logURL.map { " See \($0.path)." } ?? "")
        }
    }

    func stop(disableAutomaticStart: Bool = false) async {
        if disableAutomaticStart {
            UserDefaults.standard.set(false, forKey: Self.launchPreference)
        }
        guard let child = process else {
            closeOutput()
            return
        }
        let previousBusy = busy
        busy = true
        defer { busy = previousBusy }
        remoteRevision = UUID()
        tailscaleMonitor?.cancel()
        tailscaleMonitor = nil
        stopRequested = true
        guard await stopTailscale() else { return }
        if child.isRunning {
            running = false
            child.terminate()
        }
        let deadline = Date().addingTimeInterval(10)
        while child.isRunning, Date() < deadline {
            do {
                try await Task.sleep(for: .milliseconds(100))
            } catch {
                self.error = "Waiting for controller shutdown was interrupted."
                return
            }
        }
        guard !child.isRunning else {
            error = "The local controller has not stopped. Try again or inspect its log."
            return
        }
        child.waitUntilExit()
        await finish(child)
    }

    private func finish(_ child: Process) async {
        guard process === child, !child.isRunning else { return }
        running = false
        remoteRevision = UUID()
        tailscaleMonitor?.cancel()
        tailscaleMonitor = nil
        guard await stopTailscale(), process === child else { return }
        let expected = stopRequested
        process = nil
        running = false
        stopRequested = false
        remoteReady = false
        tailscaleConsentURL = nil
        setNetworkStatus(tailscaleEnabled ? "Tailscale access is enabled; controller stopped"
                         : managedHTTPS ? "Direct HTTPS; controller stopped" : "Local only")
        if !expected {
            error = "The local controller exited (status \(child.terminationStatus))."
                + (logURL.map { " See \($0.path)." } ?? "")
        }
        closeOutput()
    }

    private func setNetworkStatus(_ message: String) {
        guard networkStatus != message else { return }
        networkStatus = message
        do { try output?.write(contentsOf: Data(("Network access: \(message)\n").utf8)) }
        catch { self.error = "Unable to write the controller log: \(error.localizedDescription)" }
    }

    private func requireRemoteCredentials(allowSetup: Bool = false) async throws {
        struct Status: Decodable {
            let ownerExists: Bool
            let authInitialized: Bool
            let passwordConfigured: Bool
        }
        var status = try JSONDecoder().decode(Status.self, from: await runCLI(["auth", "status"]))
        if !status.ownerExists, allowSetup {
            guard try await promptOwnerPassword() else { throw CocoaError(.userCancelled) }
            status = try JSONDecoder().decode(Status.self, from: await runCLI(["auth", "status"]))
        }
        guard status.ownerExists, status.authInitialized, status.passwordConfigured else {
            throw LocalControllerFailure(message: "Before enabling remote access, initialize the owner password or add a password in Account Settings while using Local Only. Localhost passkeys do not work on the Tailscale hostname.")
        }
    }

    private func startTailscaleMonitor() {
        tailscaleMonitor?.cancel()
        tailscaleMonitor = Task { [weak self] in
            while !Task.isCancelled {
                do { try await Task.sleep(for: .seconds(5)) }
                catch { return }
                await self?.reconcileTailscale()
            }
        }
    }

    private func reconcileTailscale(allowBusy: Bool = false) async {
        guard tailscaleEnabled, running, let controller = process, controller.isRunning,
              allowBusy || !busy else { return }
        let revision = remoteRevision
        func current() -> Bool {
            revision == remoteRevision && process === controller && controller.isRunning
                && tailscaleEnabled && !Task.isCancelled && (allowBusy || !busy)
        }
        do {
            let executable = try Tailscale.executable()
            let discovered = try await Tailscale.discover(executable)
            guard current() else { return }
            guard discovered == publicEndpoint else {
                _ = await stopTailscale()
                setNetworkStatus("Tailscale hostname changed. Apply Network Access to restart with its new URL.")
                return
            }
            if tailscaleProcess == nil {
                try await requireRemoteCredentials()
                guard current() else { return }
                let config = try await Tailscale.configuration(executable)
                guard current() else { return }
                guard !config.usesPort(Tailscale.httpsPort) else {
                    throw LocalControllerFailure(message: "Tailscale HTTPS port \(Tailscale.httpsPort) is already in use. Existing publications were not changed.")
                }
                try startTailscale(executable, controller: controller)
            }
            let config = try await Tailscale.configuration(executable)
            guard current() else { return }
            guard config.forwards(discovered, port: Tailscale.httpsPort, to: Tailscale.backend) else {
                remoteReady = false
                tailscaleConsentURL = Tailscale.prerequisiteURL(in: try tailscaleLog())
                if tailscaleConsentURL != nil {
                    setNetworkStatus("Enable Serve in Tailscale to finish remote access setup.")
                } else if config.usesPort(Tailscale.httpsPort) {
                    throw LocalControllerFailure(message: "Tailscale HTTPS port \(Tailscale.httpsPort) is occupied by a different publication.")
                } else { setNetworkStatus("Waiting for Tailscale Serve. See app-tailscale.log for details.") }
                return
            }
            let session = URLSession(configuration: .ephemeral)
            defer { session.invalidateAndCancel() }
            do {
                var request = URLRequest(url: discovered.appendingPathComponent("api/health"))
                request.timeoutInterval = 3
                let (data, response) = try await session.data(for: request)
                guard current() else { return }
                guard (response as? HTTPURLResponse)?.statusCode == 200,
                      let health = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                      health["ok"] as? Bool == true, tailscaleProcess?.isRunning == true else {
                    throw LocalControllerFailure(message: "The public controller health check did not succeed.")
                }
                remoteReady = true
                tailscaleConsentURL = nil
                setNetworkStatus("Available via Tailscale")
            } catch is CancellationError { return }
            catch {
                guard current() else { return }
                remoteReady = false
                setNetworkStatus("Waiting for verified Tailscale HTTPS: \(error.localizedDescription)")
            }
        } catch is CancellationError { return }
        catch {
            guard current() else { return }
            _ = await stopTailscale()
            guard current() else { return }
            setNetworkStatus("Remote access unavailable: \(error.localizedDescription)")
        }
    }

    private func startTailscale(_ executable: URL, controller: Process) throws {
        guard tailscaleProcess == nil, let app = Bundle.main.executableURL else {
            throw LocalControllerFailure(message: "The Tailscale session is already running or the app executable is unavailable.")
        }
        let log = try controllerDirectory().appendingPathComponent("app-tailscale.log")
        if !FileManager.default.fileExists(atPath: log.path) {
            guard FileManager.default.createFile(atPath: log.path, contents: nil,
                                                 attributes: [.posixPermissions: 0o600]) else {
                throw CocoaError(.fileWriteUnknown)
            }
        }
        let handle = try FileHandle(forWritingTo: log)
        do {
            try handle.truncate(atOffset: 0)
            let input = Pipe()
            guard fcntl(input.fileHandleForWriting.fileDescriptor, F_SETFD, FD_CLOEXEC) == 0 else {
                throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
            }
            let helper = Process()
            helper.executableURL = app
            helper.arguments = ["--clanky-tailscale-session", String(controller.processIdentifier),
                                executable.path, String(Tailscale.httpsPort), Tailscale.backend]
            helper.standardInput = input
            helper.standardOutput = handle
            helper.standardError = handle
            helper.terminationHandler = { [weak self] child in
                Task { @MainActor in self?.finishTailscale(child) }
            }
            try helper.run()
            tailscaleProcess = helper
            tailscaleInput = input.fileHandleForWriting
            tailscaleOutput = handle
            tailscaleLogURL = log
            try input.fileHandleForReading.close()
            setNetworkStatus("Starting Tailscale Serve")
        } catch {
            try handle.close()
            throw error
        }
    }

    private func tailscaleLog() throws -> String {
        guard let url = tailscaleLogURL else { return "" }
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        let size = try handle.seekToEnd()
        try handle.seek(toOffset: size > 8192 ? size - 8192 : 0)
        return String(decoding: try handle.readToEnd() ?? Data(), as: UTF8.self)
    }

    private func finishTailscale(_ child: Process) {
        guard tailscaleProcess === child, !child.isRunning else { return }
        tailscaleProcess = nil
        remoteReady = false
        do {
            try tailscaleInput?.close()
            try tailscaleOutput?.close()
        } catch { self.error = "Unable to close the Tailscale session: \(error.localizedDescription)" }
        tailscaleInput = nil
        tailscaleOutput = nil
        if running, !busy, tailscaleEnabled {
            setNetworkStatus("Tailscale Serve stopped (status \(child.terminationStatus)). See app-tailscale.log.")
        }
    }

    private func stopTailscale() async -> Bool {
        remoteReady = false
        guard let child = tailscaleProcess else { return true }
        if child.isRunning { child.terminate() }
        let deadline = Date().addingTimeInterval(5)
        while child.isRunning, Date() < deadline {
            do { try await Task.sleep(for: .milliseconds(50)) }
            catch {
                self.error = "Waiting for Tailscale shutdown was interrupted. The session remains tracked."
                return false
            }
        }
        guard !child.isRunning else {
            self.error = "Tailscale publication has not stopped. The controller will remain owned; try Stop again."
            return false
        }
        child.waitUntilExit()
        finishTailscale(child)
        return true
    }

    func copyRemoteLink() {
        guard running, remoteReady, let publicEndpoint else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(publicEndpoint.absoluteString, forType: .string)
    }

    func openTailscaleSetup() {
        guard let url = tailscaleConsentURL else { return }
        if !NSWorkspace.shared.open(url) {
            error = "Unable to open the Tailscale setup page."
        }
    }

    private func closeOutput() {
        do { try output?.close() } catch {
            self.error = "Unable to close the controller log: \(error.localizedDescription)"
        }
        output = nil
    }

    private func ensurePortAvailable() throws {
        let socket = Darwin.socket(AF_INET, SOCK_STREAM, 0)
        guard socket >= 0 else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }
        defer { Darwin.close(socket) }
        var reuse: Int32 = 1
        guard setsockopt(socket, SOL_SOCKET, SO_REUSEADDR, &reuse, socklen_t(MemoryLayout<Int32>.size)) == 0 else {
            throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
        }
        var address = sockaddr_in()
        address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        address.sin_family = sa_family_t(AF_INET)
        address.sin_port = Self.port.bigEndian
        address.sin_addr.s_addr = inet_addr(managedHTTPS ? "0.0.0.0" : "127.0.0.1")
        let result = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.bind(socket, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        guard result == 0 else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }
        guard Darwin.listen(socket, 1) == 0 else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }
    }

    func configureNetworkAccess() async {
        guard !busy else { return }
        busy = true
        defer { busy = false }
        do {
            if !hasProcess {
                do { try await loadConnection() }
                catch is CancellationError { throw CancellationError() }
                catch { setNetworkStatus("Network settings need attention: \(error.localizedDescription)") }
            }
            let alert = NSAlert()
            alert.messageText = "Controller Network Access"
            alert.informativeText = "Enable remote access once; Clanky then manages Tailscale and the controller's public URL. Apply restarts a running controller and interrupts connections. Direct HTTPS listens on all interfaces and requires browser certificate trust."
            let mode = NSPopUpButton()
            mode.addItems(withTitles: ["Local Only", "Automatic Remote Access (Tailscale)", "Direct HTTPS"])
            mode.selectItem(at: managedHTTPS ? 2 : tailscaleEnabled ? 1 : 0)
            let address = NSTextField(string: managedHTTPS ? endpoint.absoluteString : "")
            address.placeholderString = "https://192.168.1.10:\(Self.port)"
            address.widthAnchor.constraint(equalToConstant: 420).isActive = true
            let status = NSTextField(wrappingLabelWithString: networkStatus)
            status.preferredMaxLayoutWidth = 420
            let fields = NSStackView(views: [mode, status,
                NSTextField(labelWithString: "Direct HTTPS address (Direct HTTPS only)"), address])
            fields.orientation = .vertical
            fields.alignment = .leading
            fields.spacing = 10
            fields.setFrameSize(fields.fittingSize)
            alert.accessoryView = fields
            alert.addButton(withTitle: "Apply and Restart")
            alert.addButton(withTitle: "Cancel")
            guard alert.runModal() == .alertFirstButtonReturn else { return }
            let selected = mode.indexOfSelectedItem
            var tailscaleURL: URL?
            if selected == 1 {
                let executable = try Tailscale.executable()
                let discovered = try await Tailscale.discover(executable)
                let config = try await Tailscale.configuration(executable)
                let owned = tailscaleProcess?.isRunning == true
                    && config.forwards(discovered, port: Tailscale.httpsPort, to: Tailscale.backend)
                guard owned || !config.usesPort(Tailscale.httpsPort) else {
                    throw LocalControllerFailure(message: "Tailscale HTTPS port \(Tailscale.httpsPort) is already in use. Existing publications were not changed.")
                }
                try await requireRemoteCredentials(allowSetup: true)
                tailscaleURL = discovered
            } else if selected == 2 {
                guard let url = URL(string: address.stringValue),
                      url.scheme == "https", let host = url.host, !host.isEmpty,
                      !["0.0.0.0", "::", "[::]"].contains(host),
                      url.port == Int(Self.port), url.user == nil, url.password == nil,
                      url.path.isEmpty || url.path == "/", url.query == nil, url.fragment == nil else {
                    throw NSError(domain: "Clanky", code: 12, userInfo: [
                        NSLocalizedDescriptionKey: "Enter a fixed HTTPS IP or hostname on port \(Self.port), without a path or credentials."
                    ])
                }
            }
            let wasRunning = hasProcess
            if wasRunning {
                await stop()
                guard !hasProcess else {
                    throw LocalControllerFailure(message: "Network settings were not changed because the controller did not stop.")
                }
            }
            let arguments = selected == 2
                ? ["controller", "tls", "enable", "--endpoint", address.stringValue]
                : ["controller", "tls", "disable"]
            _ = try await runCLI(arguments)
            if let tailscaleURL {
                UserDefaults.standard.set(tailscaleURL.absoluteString, forKey: Self.tailscaleURLPreference)
            }
            UserDefaults.standard.set(selected == 1, forKey: Self.tailscalePreference)
            tailscaleConsentURL = nil
            try await loadConnection()
            if wasRunning {
                busy = false
                await start()
            }
        } catch let failure as CocoaError where failure.code == .userCancelled { return }
        catch { self.error = "Unable to configure network access: \(error.localizedDescription)" }
    }

    func initializeOwnerPassword() async {
        guard !busy else { return }
        busy = true
        defer { busy = false }
        do { _ = try await promptOwnerPassword() }
        catch { self.error = "Unable to initialize the owner: \(error.localizedDescription)" }
    }

    private func promptOwnerPassword() async throws -> Bool {
        let alert = NSAlert()
        alert.messageText = "Initialize Controller Owner"
        alert.informativeText = "Only for a controller with no owner. Existing accounts create or change their password in Account Settings."
        let username = NSTextField(string: "")
        let password = NSSecureTextField(string: "")
        defer { password.stringValue = "" }
        username.placeholderString = "Username"
        password.placeholderString = "Password (at least 12 characters)"
        username.widthAnchor.constraint(equalToConstant: 320).isActive = true
        password.widthAnchor.constraint(equalToConstant: 320).isActive = true
        let fields = NSStackView(views: [username, password])
        fields.orientation = .vertical
        fields.spacing = 10
        fields.setFrameSize(fields.fittingSize)
        alert.accessoryView = fields
        alert.addButton(withTitle: "Initialize")
        alert.addButton(withTitle: "Cancel")
        guard alert.runModal() == .alertFirstButtonReturn else { return false }
        _ = try await runCLI(["auth", "setup", "--username", username.stringValue, "--password-stdin"],
                             input: password.stringValue)
        return true
    }

    func exportCertificate() async {
        guard !busy else { return }
        busy = true
        defer { busy = false }
        do {
            let certificate = try await runCLI(["controller", "tls", "export"])
            let panel = NSSavePanel()
            panel.nameFieldStringValue = "clanky-controller.pem"
            guard panel.runModal() == .OK, let url = panel.url else { return }
            try certificate.write(to: url, options: .atomic)
        } catch {
            self.error = "Unable to export the controller certificate: \(error.localizedDescription)"
        }
    }
}

fileprivate struct ControllerTlsState: Decodable {
    let enabled: Bool
    let endpoint: URL?
    let certificate: String?
    let notBefore: String?
    let notAfter: String?
}

final class ControllerTlsTrust: NSObject, URLSessionDelegate, @unchecked Sendable {
    private let endpoint: URL
    private let certificate: SecCertificate
    private let notBefore: Date
    private let notAfter: Date

    fileprivate init(state: ControllerTlsState) throws {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let endpoint = state.endpoint, let pem = state.certificate,
              let before = state.notBefore.flatMap(formatter.date(from:)),
              let after = state.notAfter.flatMap(formatter.date(from:)),
              let data = Data(base64Encoded: pem
                .replacingOccurrences(of: "-----BEGIN CERTIFICATE-----", with: "")
                .replacingOccurrences(of: "-----END CERTIFICATE-----", with: "")
                .components(separatedBy: .whitespacesAndNewlines).joined()),
              let certificate = SecCertificateCreateWithData(nil, data as CFData) else {
            throw NSError(domain: "Clanky", code: 11, userInfo: [
                NSLocalizedDescriptionKey: "The local controller's trusted certificate is missing or invalid."
            ])
        }
        self.endpoint = endpoint
        self.certificate = certificate
        notBefore = before
        notAfter = after
    }

    func decision(_ challenge: URLAuthenticationChallenge) -> (URLSession.AuthChallengeDisposition, URLCredential?)? {
        let space = challenge.protectionSpace
        let brackets = CharacterSet(charactersIn: "[]")
        guard space.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              space.host.trimmingCharacters(in: brackets).lowercased()
                == endpoint.host?.trimmingCharacters(in: brackets).lowercased(),
              space.port == (endpoint.port ?? 443) else { return nil }
        guard Date() >= notBefore, Date() < notAfter, let trust = space.serverTrust,
              SecTrustSetAnchorCertificates(trust, [certificate] as CFArray) == errSecSuccess,
              SecTrustSetAnchorCertificatesOnly(trust, true) == errSecSuccess,
              SecTrustEvaluateWithError(trust, nil),
              let chain = SecTrustCopyCertificateChain(trust) as? [SecCertificate],
              let leaf = chain.first,
              (SecCertificateCopyData(leaf) as Data) == (SecCertificateCopyData(certificate) as Data) else {
            return (.cancelAuthenticationChallenge, nil)
        }
        return (.useCredential, URLCredential(trust: trust))
    }

    func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        let decision = decision(challenge) ?? (.performDefaultHandling, nil)
        completionHandler(decision.0, decision.1)
    }
}

struct ControllerCommands: Commands {
    @ObservedObject var controller: LocalController
    @FocusedObject private var browser: BrowserModel?

    var body: some Commands {
        CommandMenu("Local Controller") {
            Button("Network Access...") { Task { await controller.configureNetworkAccess() } }
                .disabled(controller.busy)
            Text(controller.networkStatus)
            if let endpoint = controller.publicEndpoint {
                Text(endpoint.absoluteString)
            }
            Button("Copy Remote Link") { controller.copyRemoteLink() }
                .disabled(controller.busy || !controller.remoteReady)
            if controller.tailscaleConsentURL != nil {
                Button("Finish Tailscale Setup...") { controller.openTailscaleSetup() }
            }
            Divider()
            Button("Initialize Owner Password...") { Task { await controller.initializeOwnerPassword() } }
                .disabled(controller.busy)
            Button("Export Controller Certificate...") { Task { await controller.exportCertificate() } }
                .disabled(controller.busy || !controller.managedHTTPS)
            Divider()
            Group {
                if controller.hasProcess {
                    Button("Connect to Local Controller") {
                        if let browser { connect(browser) }
                    }
                    .disabled(!controller.canConnect)
                    Button("Stop Local Controller") {
                        Task { await controller.stop(disableAutomaticStart: true) }
                    }
                } else {
                    Button("Start Local Controller") {
                        if let browser {
                            Task {
                                await controller.start()
                                if controller.canConnect { connect(browser) }
                            }
                        }
                    }
                }
            }
            .disabled(controller.busy || browser == nil)
        }
    }

    private func connect(_ browser: BrowserModel) {
        browser.load(browser.origin.appendingPathComponent("local/"))
    }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    weak var model: AppModel?

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard let model else { return .terminateNow }
        Task {
            await model.controller.stop()
            let stopped = !model.controller.hasProcess
            if stopped { await model.stopAssets() }
            sender.reply(toApplicationShouldTerminate: stopped)
            if !stopped, sender.windows.allSatisfy({ !$0.isVisible }) {
                let alert = NSAlert()
                alert.messageText = "Clanky could not quit"
                alert.informativeText = model.controller.error ?? "The local controller is still running."
                model.controller.error = nil
                alert.runModal()
            }
        }
        return .terminateLater
    }
}
#endif
