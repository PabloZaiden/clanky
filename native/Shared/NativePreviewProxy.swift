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
    private var ipv6Listener: NWListener?
    private var availablePortAttempts = 0
    private var session: URLSession?
    private var socket: URLSessionWebSocketTask?
    private var reader: Task<Void, Never>?
    private var startup: CheckedContinuation<Void, Error>?
    private var startupTimeout: Task<Void, Never>?
    private var connections: [String: PreviewBrowserConnection] = [:]
    private var pending: [(String, CheckedContinuation<Void, Error>)] = []
    private var pendingBytes = 0
    private var sending = false
    // HTTP(S) bad ports: https://fetch.spec.whatwg.org/#port-blocking
    private static let browserBlockedPorts: Set<UInt16> = [
        0, 1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53,
        69, 77, 79, 87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117,
        119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514,
        515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989,
        990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061,
        6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080,
    ]

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
        let port = localURL?.port ?? 0
        return port == 80 ? "http://localhost" : "http://localhost:\(port)"
    }

    func start() async throws {
        try await withCheckedThrowingContinuation { continuation in
            startup = continuation
            startupTimeout = Task { [weak self] in
                do { try await Task.sleep(for: .seconds(20)) } catch { return }
                self?.stop("Preview startup timed out.")
            }
            if Self.browserBlockedPorts.contains(UInt16(remotePort)) {
                NSLog("Clanky preview remote port %d is blocked by browsers; selecting a different local port.", remotePort)
                startAvailablePort()
            } else {
                do {
                    try startListener(port: NWEndpoint.Port(rawValue: UInt16(remotePort))!, ipv6: false)
                } catch {
                    listenerFailed(error, ipv6: false)
                }
            }
        }
    }

    private func startListener(port: NWEndpoint.Port, ipv6: Bool) throws {
        let parameters = NWParameters.tcp
        // Allow the IPv6 listener to reserve this port too, not the same address.
        parameters.allowLocalEndpointReuse = !ipv6
        parameters.requiredLocalEndpoint = .hostPort(
            host: ipv6 ? .ipv6(.loopback) : .ipv4(.loopback), port: port)
        let listener = try NWListener(using: parameters)
        if ipv6 { ipv6Listener = listener } else { self.listener = listener }
        listener.stateUpdateHandler = { [weak self] state in
            Task { @MainActor in
                guard let self, (self.status == "starting" || self.status == "active"),
                      (ipv6 ? self.ipv6Listener : self.listener) === listener else { return }
                switch state {
                case .ready:
                    if ipv6 {
                        self.connect()
                    } else {
                        guard let port = listener.port else {
                            self.stop("The preview listener did not provide a local port.")
                            return
                        }
                        guard !Self.browserBlockedPorts.contains(port.rawValue) else {
                            NSLog("Selected local port %d is blocked by browsers.", port.rawValue)
                            self.startAvailablePort()
                            return
                        }
                        guard let url = URL(string: "http://localhost:\(port.rawValue)\(self.initialPath)"),
                              url.host == "localhost", url.port == Int(port.rawValue) else {
                            self.stop("The preview listener did not provide a valid local URL.")
                            return
                        }
                        self.localURL = url
                        do { try self.startListener(port: port, ipv6: true) }
                        catch { self.listenerFailed(error, ipv6: true) }
                    }
                case .failed(let failure), .waiting(let failure):
                    self.listenerFailed(failure, ipv6: ipv6)
                case .cancelled:
                    self.stop("The preview listener stopped.")
                default: break
                }
            }
        }
        listener.newConnectionHandler = { [weak self] connection in
            Task { @MainActor in
                guard let self, self.status == "active", self.connections.count < 64,
                      (ipv6 ? self.ipv6Listener : self.listener) === listener else {
                    connection.cancel()
                    return
                }
                let browser = PreviewBrowserConnection(connection: connection, proxy: self)
                self.connections[browser.id] = browser
                browser.start()
            }
        }
        listener.start(queue: .main)
    }

    private func listenerFailed(_ failure: Error, ipv6: Bool) {
        if status == "starting", socket == nil, let networkError = failure as? NWError,
           case .posix(let code) = networkError {
            if ipv6, [.EAFNOSUPPORT, .EADDRNOTAVAIL, .EPROTONOSUPPORT].contains(code) {
                NSLog("Clanky preview IPv6 loopback is unavailable; listening on IPv4 only: %@", failure.localizedDescription)
                cancelListener(ipv6Listener)
                ipv6Listener = nil
                connect()
                return
            }
            if [.EADDRINUSE, .EACCES, .EPERM].contains(code) {
                NSLog("Clanky preview local port is unavailable: %@", failure.localizedDescription)
                startAvailablePort()
                return
            }
        }
        stop("Preview listener failed: \(failure.localizedDescription)")
    }

    private func startAvailablePort() {
        guard availablePortAttempts < 8 else {
            stop("Unable to select a browser-usable local preview port.")
            return
        }
        availablePortAttempts += 1
        NSLog("Using an available local preview port (attempt %d).", availablePortAttempts)
        stopListeners()
        localURL = nil
        do { try startListener(port: .any, ipv6: false) }
        catch { listenerFailed(error, ipv6: false) }
    }

    private func cancelListener(_ listener: NWListener?) {
        listener?.stateUpdateHandler = nil
        listener?.newConnectionHandler = nil
        listener?.cancel()
    }

    private func stopListeners() {
        cancelListener(listener)
        cancelListener(ipv6Listener)
        listener = nil
        ipv6Listener = nil
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
                "localHost": "localhost", "localPort": localURL.port!, "localUrl": localURL.absoluteString,
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
        let data = try JSONSerialization.data(withJSONObject: message, options: [.withoutEscapingSlashes])
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
        stopListeners()
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
