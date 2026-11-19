import Foundation
import Network

struct NativePreviewFailure: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

@MainActor
final class NativePreviewProxy: NSObject, URLSessionTaskDelegate {
    let id = UUID().uuidString
    let page: String
    let target: [String: String]
    let remotePort: Int
    let initialPath: String
    let upstreamProtocol: String
    private(set) var previewID: String?
    private(set) var localURL: URL?
    private(set) var status = "starting"
    private(set) var error: String?
    private let socketURL: URL
    private let origin: URL
    private let trust: @MainActor (URLAuthenticationChallenge) -> (URLSession.AuthChallengeDisposition, URLCredential?)?
    private let changed: @MainActor () -> Void
    private var listener: NWListener?
    private var session: URLSession?
    private var socket: URLSessionWebSocketTask?
    private var reader: Task<Void, Never>?
    private var startup: CheckedContinuation<Void, Error>?
    private var startupTimeout: Task<Void, Never>?
    private var connections: [String: PreviewBrowserConnection] = [:]
    private var pending: [(String, CheckedContinuation<Void, Error>)] = []
    private var pendingBytes = 0
    private var sending = false

    init(page: String, target: [String: String], port: Int, path: String, upstreamProtocol: String,
         socketURL: URL, origin: URL,
         trust: @escaping @MainActor (URLAuthenticationChallenge) -> (URLSession.AuthChallengeDisposition, URLCredential?)?,
         changed: @escaping @MainActor () -> Void) {
        self.page = page
        self.target = target
        remotePort = port
        initialPath = path
        self.upstreamProtocol = upstreamProtocol
        self.socketURL = socketURL
        self.origin = origin
        self.trust = trust
        self.changed = changed
    }

    var snapshot: [String: Any] {
        var result: [String: Any] = [
            "id": id, "target": target, "port": remotePort, "path": initialPath,
            "protocol": upstreamProtocol, "status": status,
        ]
        if let previewID { result["previewId"] = previewID }
        if let localURL { result["url"] = localURL.absoluteString }
        if let error { result["error"] = error }
        return result
    }

    var localOrigin: String {
        "http://127.0.0.1:\(localURL?.port ?? 0)"
    }

    func start() async throws {
        try await withCheckedThrowingContinuation { continuation in
            startup = continuation
            startupTimeout = Task { [weak self] in
                do { try await Task.sleep(for: .seconds(20)) } catch { return }
                self?.stop("Preview startup timed out.")
            }
            do {
                let parameters = NWParameters.tcp
                parameters.requiredLocalEndpoint = .hostPort(host: .ipv4(.loopback), port: .any)
                let listener = try NWListener(using: parameters)
                self.listener = listener
                listener.stateUpdateHandler = { [weak self] state in
                    Task { @MainActor in
                        guard let self, self.status == "starting" || self.status == "active" else { return }
                        switch state {
                        case .ready:
                            guard let port = listener.port,
                                  let url = URL(string: "http://127.0.0.1:\(port.rawValue)\(self.initialPath)"),
                                  url.host == "127.0.0.1", url.port == Int(port.rawValue) else {
                                self.stop("The preview listener did not provide a valid local URL.")
                                return
                            }
                            self.localURL = url
                            self.connect()
                        case .failed(let failure), .waiting(let failure):
                            self.stop("Preview listener failed: \(failure.localizedDescription)")
                        case .cancelled:
                            self.stop("The preview listener stopped.")
                        default: break
                        }
                    }
                }
                listener.newConnectionHandler = { [weak self] connection in
                    Task { @MainActor in
                        guard let self, self.status == "active", self.connections.count < 64 else {
                            connection.cancel()
                            return
                        }
                        let browser = PreviewBrowserConnection(connection: connection, proxy: self)
                        self.connections[browser.id] = browser
                        browser.start()
                    }
                }
                listener.start(queue: .main)
            } catch {
                stop("Unable to start preview: \(error.localizedDescription)")
            }
        }
    }

    private func connect() {
        guard socket == nil else { return }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil
        configuration.urlCredentialStorage = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        let session = URLSession(configuration: configuration, delegate: self, delegateQueue: .main)
        self.session = session
        var request = URLRequest(url: socketURL)
        request.setValue(origin.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/")),
                         forHTTPHeaderField: "Origin")
        let socket = session.webSocketTask(with: request)
        socket.maximumMessageSize = 12 * 1024 * 1024
        self.socket = socket
        socket.resume()
        reader = Task { [weak self] in
            do {
                while !Task.isCancelled {
                    let message = try await socket.receive()
                    guard let self, self.status == "starting" || self.status == "active" else { return }
                    let data: Data
                    switch message {
                    case .string(let value): data = Data(value.utf8)
                    case .data(let value): data = value
                    @unknown default: throw NativePreviewFailure(message: "Unknown preview transport message.")
                    }
                    try self.receive(data)
                }
            } catch {
                self?.stop("Preview connection ended: \(error.localizedDescription)")
            }
        }
        Task { [weak self] in
            guard let self, let localURL else { return }
            await forward([
                "type": "hello", "target": target, "remoteHost": "localhost", "remotePort": remotePort,
                "localHost": "127.0.0.1", "localPort": localURL.port!, "localUrl": localURL.absoluteString,
                "initialPath": initialPath, "protocol": upstreamProtocol,
                "cliClientId": id, "cliHostname": ProcessInfo.processInfo.hostName,
            ])
        }
    }

    private func receive(_ data: Data) throws {
        guard let message = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = message["type"] as? String else {
            throw NativePreviewFailure(message: "Invalid preview transport response.")
        }
        switch type {
        case "connected": return
        case "bridge.ping":
            Task { await forward(["type": "bridge.pong"]) }
        case "ready":
            guard status == "starting", let previewID = message["previewId"] as? String, !previewID.isEmpty else {
                throw NativePreviewFailure(message: "Invalid preview registration response.")
            }
            self.previewID = previewID
            status = "active"
            startupTimeout?.cancel()
            startupTimeout = nil
            let continuation = startup
            startup = nil
            continuation?.resume()
            changed()
        case "stream.error" where message["streamId"] == nil:
            throw NativePreviewFailure(message: message["error"] as? String ?? "Preview registration failed.")
        default:
            guard let streamID = message["streamId"] as? String else {
                throw NativePreviewFailure(message: "Missing preview response stream.")
            }
            try connections[streamID]?.receive(message)
        }
    }

    func send(_ message: [String: Any]) async throws {
        guard status == "starting" || status == "active", socket != nil else {
            throw NativePreviewFailure(message: error ?? "The preview connection is closed.")
        }
        let data = try JSONSerialization.data(withJSONObject: message)
        guard pendingBytes + data.count <= 16 * 1024 * 1024 else {
            throw NativePreviewFailure(message: "Preview transport buffer limit exceeded.")
        }
        let value = String(decoding: data, as: UTF8.self)
        try await withCheckedThrowingContinuation { continuation in
            pendingBytes += value.utf8.count
            pending.append((value, continuation))
            guard !sending else { return }
            sending = true
            Task { await drain() }
        }
    }

    private func drain() async {
        while !pending.isEmpty {
            let (value, continuation) = pending.removeFirst()
            do {
                guard let socket else { throw NativePreviewFailure(message: "Preview transport is closed.") }
                try await socket.send(.string(value))
                pendingBytes -= value.utf8.count
                continuation.resume()
            } catch {
                pendingBytes -= value.utf8.count
                continuation.resume(throwing: error)
                stop("Preview transport failed: \(error.localizedDescription)")
            }
        }
        sending = false
    }

    func forward(_ message: [String: Any]) async {
        do { try await send(message) }
        catch { stop("Preview transport failed: \(error.localizedDescription)") }
    }

    func release(_ id: String, webSocket: Bool) {
        connections.removeValue(forKey: id)
        guard status == "active" else { return }
        Task { await forward([
            "type": webSocket ? "websocket.close" : "request.cancel", "streamId": id, "code": 1000,
        ]) }
    }

    var bufferedBrowserBytes: Int {
        connections.values.reduce(0) { $0 + $1.bufferedBytes }
    }

    func stop(_ reason: String) {
        guard status == "starting" || status == "active" else { return }
        status = "interrupted"
        error = reason
        NSLog("Clanky local preview stopped: %@", reason)
        startupTimeout?.cancel()
        startupTimeout = nil
        let continuation = startup
        startup = nil
        continuation?.resume(throwing: NativePreviewFailure(message: reason))
        listener?.stateUpdateHandler = nil
        listener?.newConnectionHandler = nil
        listener?.cancel()
        listener = nil
        reader?.cancel()
        reader = nil
        socket?.cancel(with: .goingAway, reason: nil)
        socket = nil
        session?.invalidateAndCancel()
        session = nil
        let requests = pending
        pending.removeAll()
        for (value, reply) in requests {
            pendingBytes -= value.utf8.count
            reply.resume(throwing: NativePreviewFailure(message: reason))
        }
        let browsers = Array(connections.values)
        connections.removeAll()
        for browser in browsers { browser.close() }
        changed()
    }

    nonisolated func urlSession(_ session: URLSession, task: URLSessionTask,
                               didReceive challenge: URLAuthenticationChallenge,
                               completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        Task { @MainActor in
            let decision = trust(challenge) ?? (.performDefaultHandling, nil)
            completionHandler(decision.0, decision.1)
        }
    }

    nonisolated func urlSession(_ session: URLSession, task: URLSessionTask,
                               willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
                               completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}
