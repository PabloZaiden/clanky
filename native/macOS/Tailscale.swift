#if os(macOS)
import Foundation

struct LocalControllerFailure: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

func runNativeCommand(_ executable: URL, arguments: [String], environment: [String: String]? = nil,
                      input: String? = nil, timeout: TimeInterval = 15) async throws -> Data {
    let child = Process()
    let output = Pipe(), errors = Pipe(), secret = Pipe()
    child.executableURL = executable
    child.arguments = arguments
    child.environment = environment
    child.currentDirectoryURL = FileManager.default.homeDirectoryForCurrentUser
    child.standardOutput = output
    child.standardError = errors
    child.standardInput = input == nil ? FileHandle.nullDevice : secret
    try child.run()
    let outputHandle = output.fileHandleForReading, errorHandle = errors.fileHandleForReading
    let outputRead = Task.detached { try outputHandle.readToEnd() ?? Data() }
    let errorRead = Task.detached { try errorHandle.readToEnd() ?? Data() }
    do {
        if let input {
            try secret.fileHandleForWriting.write(contentsOf: Data((input + "\n").utf8))
            try secret.fileHandleForWriting.close()
        }
        let deadline = Date().addingTimeInterval(timeout)
        while child.isRunning, Date() < deadline {
            try await Task.sleep(for: .milliseconds(50))
        }
        guard !child.isRunning else {
            throw LocalControllerFailure(message: "The configuration command timed out. Check its state before trying again.")
        }
        child.waitUntilExit()
        let data = try await outputRead.value
        let diagnostics = try await errorRead.value
        guard child.terminationStatus == 0 else {
            let message = String(decoding: diagnostics.isEmpty ? data : diagnostics, as: UTF8.self)
                .trimmingCharacters(in: .whitespacesAndNewlines)
            throw LocalControllerFailure(message: message.isEmpty
                ? "\(executable.lastPathComponent) exited with status \(child.terminationStatus)." : message)
        }
        return data
    } catch {
        if child.isRunning {
            child.terminate()
            let deadline = Date().addingTimeInterval(2)
            while child.isRunning, Date() < deadline {
                do { try await Task.sleep(for: .milliseconds(50)) }
                catch { break }
            }
            if child.isRunning { Darwin.kill(child.processIdentifier, SIGKILL) }
            child.waitUntilExit()
        }
        _ = await outputRead.result
        _ = await errorRead.result
        throw error
    }
}

struct TailscaleNode: Decodable {
    struct Peer: Decodable {
        let DNSName: String
        let Online: Bool
    }
    let BackendState: String
    let peer: Peer?
    private enum CodingKeys: String, CodingKey { case BackendState; case peer = "Self" }

    var endpoint: URL {
        get throws {
            guard BackendState == "Running", let peer, peer.Online else {
                throw LocalControllerFailure(message: "Connect and sign in to Tailscale, then try again.")
            }
            return try Tailscale.httpsURL(peer.DNSName)
        }
    }
}

struct TailscaleServeConfig: Decodable {
    struct TCPHandler: Decodable { let HTTPS: Bool? }
    struct Handler: Decodable { let Proxy: String? }
    struct WebServer: Decodable { let Handlers: [String: Handler]? }
    let TCP: [String: TCPHandler]?
    let Web: [String: WebServer]?
    let Foreground: [String: TailscaleServeConfig]?
    let AllowFunnel: [String: Bool]?

    func usesPort(_ port: UInt16) -> Bool {
        TCP?[String(port)] != nil
            || Web?.keys.contains(where: { $0.hasSuffix(":\(port)") }) == true
            || AllowFunnel?.contains(where: { $0.key.hasSuffix(":\(port)") && $0.value }) == true
            || Foreground?.values.contains(where: { $0.usesPort(port) }) == true
    }

    func forwards(_ endpoint: URL, port: UInt16, to target: String) -> Bool {
        let host = "\(endpoint.host ?? ""):\(port)"
        return (TCP?[String(port)]?.HTTPS == true && Web?[host]?.Handlers?["/"]?.Proxy == target)
            || Foreground?.values.contains(where: { $0.forwards(endpoint, port: port, to: target) }) == true
    }
}

enum Tailscale {
    static let httpsPort: UInt16 = 443
    static let backend = "http://127.0.0.1:\(LocalController.port)"

    static func httpsURL(_ dnsName: String) throws -> URL {
        let name = dnsName.trimmingCharacters(in: CharacterSet(charactersIn: ".")).lowercased()
        guard name.hasSuffix(".ts.net"), name.utf8.count <= 253,
              name.split(separator: ".", omittingEmptySubsequences: false).allSatisfy({ label in
                  !label.isEmpty && label.count <= 63 && label.first != "-" && label.last != "-"
                      && label.utf8.allSatisfy({ (97...122).contains($0) || (48...57).contains($0) || $0 == 45 })
              }), let url = URL(string: "https://\(name)") else {
            throw LocalControllerFailure(message: "Tailscale did not provide a valid HTTPS hostname. Enable MagicDNS and HTTPS in Tailscale.")
        }
        return url
    }

    static func executable() throws -> URL {
        let home = FileManager.default.homeDirectoryForCurrentUser
        let paths = (ProcessInfo.processInfo.environment["PATH"] ?? "").split(separator: ":")
            .map { String($0) + "/tailscale" } + [
                "/opt/homebrew/bin/tailscale", "/usr/local/bin/tailscale",
                "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
                home.appendingPathComponent("Applications/Tailscale.app/Contents/MacOS/Tailscale").path,
            ]
        guard let path = paths.first(where: { FileManager.default.isExecutableFile(atPath: $0) }) else {
            throw LocalControllerFailure(message: "Install Tailscale and sign in to enable automatic remote access.")
        }
        return URL(fileURLWithPath: path)
    }

    static func discover(_ executable: URL) async throws -> URL {
        let data = try await runNativeCommand(executable, arguments: ["status", "--json"], timeout: 5)
        return try JSONDecoder().decode(TailscaleNode.self, from: data).endpoint
    }

    static func configuration(_ executable: URL) async throws -> TailscaleServeConfig {
        let data = try await runNativeCommand(executable, arguments: ["serve", "status", "--json"], timeout: 5)
        return try JSONDecoder().decode(TailscaleServeConfig.self, from: data)
    }

    static func prerequisiteURL(in log: String) -> URL? {
        for word in log.split(whereSeparator: { $0.isWhitespace }) {
            guard let url = URL(string: String(word)), url.scheme == "https",
                  url.host == "login.tailscale.com", url.path == "/f/serve",
                  url.user == nil, url.password == nil, url.port == nil else { continue }
            return url
        }
        return nil
    }
}

// A separate process observes stdin EOF and controller exit even if the GUI is killed.
final class TailscaleServeSession {
    private let queue = DispatchQueue(label: "com.clanky.tailscale-session")
    private let child = Process()
    private let controller: pid_t
    private var sources: [any DispatchSourceProtocol] = []
    private var controllerAlive = true
    private var stopping = false
    private var stopController = false
    private var result: Int32 = 0

    init(controller: pid_t, executable: URL, port: UInt16, target: String) {
        self.controller = controller
        child.executableURL = executable
        // Never answer an overwrite prompt on the user's behalf.
        child.arguments = ["serve", "--https=\(port)", target]
        child.standardInput = FileHandle.nullDevice
        child.standardOutput = FileHandle.standardOutput
        child.standardError = FileHandle.standardError
    }

    static func runIfRequested() {
        let arguments = CommandLine.arguments
        guard arguments.dropFirst().first == "--clanky-tailscale-session" else { return }
        guard arguments.count == 6, let controller = pid_t(arguments[2]), controller > 1,
              let port = UInt16(arguments[4]), port > 0,
              let target = URL(string: arguments[5]), target.scheme == "http",
              target.host == "127.0.0.1", target.port != nil,
              target.user == nil, target.password == nil, target.path.isEmpty,
              target.query == nil, target.fragment == nil else {
            FileHandle.standardError.write(Data("Invalid managed Tailscale session arguments.\n".utf8))
            exit(2)
        }
        TailscaleServeSession(controller: controller, executable: URL(fileURLWithPath: arguments[3]),
                              port: port, target: arguments[5]).run()
    }

    private func run() -> Never {
        let input = DispatchSource.makeReadSource(fileDescriptor: STDIN_FILENO, queue: queue)
        input.setEventHandler { [self] in
            var byte: UInt8 = 0
            let count = Darwin.read(STDIN_FILENO, &byte, 1)
            if count == 0 {
                input.cancel()
                shutdown(stopController: true)
            }
            else if count < 0 && errno != EINTR {
                input.cancel()
                FileHandle.standardError.write(Data("Unable to observe the app lifetime.\n".utf8))
                shutdown(stopController: true, result: 1)
            }
        }
        sources.append(input)
        let controllerExit = DispatchSource.makeProcessSource(identifier: controller, eventMask: .exit, queue: queue)
        controllerExit.setEventHandler { [self] in
            controllerAlive = false
            if stopping { finish() } else { shutdown() }
        }
        sources.append(controllerExit)
        for number in [SIGTERM, SIGINT, SIGHUP] {
            Darwin.signal(number, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: number, queue: queue)
            source.setEventHandler { [self] in shutdown() }
            sources.append(source)
        }
        for source in sources { source.resume() }
        child.terminationHandler = { [self] process in
            queue.async {
                if !self.stopping { self.result = process.terminationStatus == 0 ? 1 : process.terminationStatus }
                self.stopping = true
                self.finish()
            }
        }
        queue.async { [self] in
            guard !stopping else { return }
            guard Darwin.kill(controller, 0) == 0 else { exit(1) }
            do { try child.run() }
            catch {
                FileHandle.standardError.write(Data(("Unable to start Tailscale Serve: \(error.localizedDescription)\n").utf8))
                exit(1)
            }
        }
        dispatchMain()
    }

    private func shutdown(stopController: Bool = false, result: Int32 = 0) {
        self.stopController = self.stopController || stopController
        guard !stopping else { return }
        stopping = true
        self.result = result
        if child.isRunning {
            child.terminate()
            queue.asyncAfter(deadline: .now() + 2) { [self] in
                if child.isRunning { Darwin.kill(child.processIdentifier, SIGKILL) }
            }
        } else { finish() }
    }

    private func finish() {
        guard !child.isRunning else { return }
        if stopController, controllerAlive {
            Darwin.kill(controller, SIGTERM)
            queue.asyncAfter(deadline: .now() + 10) { [self] in
                if controllerAlive { Darwin.kill(controller, SIGKILL) }
            }
            return
        }
        exit(result)
    }
}
#endif
