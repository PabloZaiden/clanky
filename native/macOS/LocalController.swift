#if os(macOS)
import AppKit
import Foundation
import SwiftUI

@MainActor
final class LocalController: ObservableObject {
    static let port: UInt16 = 49372
    static let endpoint = URL(string: "http://localhost:\(port)")!
    @Published private(set) var running = false
    @Published private(set) var busy = false
    @Published var error: String?
    private var process: Process?
    private var output: FileHandle?
    private var logURL: URL?
    private var stopRequested = false
    var hasProcess: Bool { process?.isRunning == true }

    func start() async {
        guard process == nil, !busy else { return }
        busy = true
        error = nil
        defer { busy = false }
        do {
            try ensurePortAvailable()
            let executable = Bundle.main.bundleURL.appendingPathComponent("Contents/Helpers/clanky")
            guard FileManager.default.isExecutableFile(atPath: executable.path) else {
                throw NSError(domain: "Clanky", code: 2, userInfo: [
                    NSLocalizedDescriptionKey: "The bundled Clanky CLI is missing. Build the macOS app with its controller."
                ])
            }
            let directory = try FileManager.default.url(
                for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
                .appendingPathComponent(Bundle.main.bundleIdentifier ?? "com.clanky.app")
                .appendingPathComponent("Controller")
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
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
            var environment = ProcessInfo.processInfo.environment.filter { !$0.key.hasPrefix("CLANKY_") }
            environment["CLANKY_DATA_DIR"] = directory.path
            environment["CLANKY_HOST"] = "127.0.0.1"
            environment["CLANKY_PORT"] = String(Self.port)
            environment["CLANKY_PUBLIC_BASE_URL"] = Self.endpoint.absoluteString
            child.environment = environment
            child.currentDirectoryURL = FileManager.default.homeDirectoryForCurrentUser
            child.standardInput = FileHandle.nullDevice
            child.standardOutput = handle
            child.standardError = handle
            child.terminationHandler = { [weak self] child in
                Task { @MainActor in
                    self?.finish(child)
                }
            }
            stopRequested = false
            try child.run()
            process = child
            let deadline = Date().addingTimeInterval(10)
            var lastFailure = "Controller did not become ready."
            while Date() < deadline {
                guard child.isRunning else {
                    throw NSError(domain: "Clanky", code: 4, userInfo: [
                        NSLocalizedDescriptionKey: "The bundled CLI exited with status \(child.terminationStatus)."
                    ])
                }
                do {
                    var request = URLRequest(url: Self.endpoint.appendingPathComponent("api/health"))
                    request.timeoutInterval = 1
                    let (data, response) = try await URLSession.shared.data(for: request)
                    if (response as? HTTPURLResponse)?.statusCode == 200,
                       let health = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                       health["ok"] as? Bool == true, child.isRunning {
                        running = true
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

    func stop() async {
        guard let child = process else {
            closeOutput()
            return
        }
        busy = true
        defer { busy = false }
        if child.isRunning {
            stopRequested = true
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
        finish(child)
    }

    private func finish(_ child: Process) {
        guard process === child, !child.isRunning else { return }
        let expected = stopRequested
        process = nil
        running = false
        stopRequested = false
        if !expected {
            error = "The local controller exited (status \(child.terminationStatus))."
                + (logURL.map { " See \($0.path)." } ?? "")
        }
        closeOutput()
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
        address.sin_addr.s_addr = inet_addr("127.0.0.1")
        let result = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.bind(socket, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        guard result == 0 else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }
        guard Darwin.listen(socket, 1) == 0 else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }
    }
}

struct ControllerCommands: Commands {
    @ObservedObject var controller: LocalController
    @FocusedObject private var browser: BrowserModel?

    var body: some Commands {
        CommandMenu("Local Controller") {
            Group {
                if controller.running {
                    Button("Connect to Local Controller") {
                        if let browser { connect(browser) }
                    }
                    Button("Stop Local Controller") { Task { await controller.stop() } }
                } else {
                    Button("Start Local Controller") {
                        if let browser {
                            Task {
                                await controller.start()
                                if controller.running { connect(browser) }
                            }
                        }
                    }
                }
            }
            .disabled(controller.busy || browser == nil)
        }
    }

    private func connect(_ browser: BrowserModel) {
        browser.webView.load(URLRequest(url: browser.origin.appendingPathComponent("local/")))
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
            if stopped { model.stopAssets() }
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
