import Foundation
import Network
import UniformTypeIdentifiers

/// A loopback origin keeps bundled content eligible for Web Crypto, Web Locks and workers.
final class AssetServer: @unchecked Sendable {
    private let root: URL
    private let localAPI: URL?
    private let requestedPort: UInt16?
    private let queue = DispatchQueue(label: "clanky.assets")
    private var listener: NWListener?
    private var boundPort: UInt16?
    private var connections: [UUID: NWConnection] = [:]
    // Set before start; all listener/connection state is confined to queue.
    let onFailure: @Sendable (Error) -> Void

    init(root: URL, port: UInt16? = nil, localAPI: URL? = nil, onFailure: @escaping @Sendable (Error) -> Void = { error in
        NSLog("Clanky asset server failed: %@", error.localizedDescription)
    }) {
        self.root = root.resolvingSymlinksInPath()
        self.localAPI = localAPI
        self.requestedPort = port
        self.onFailure = onFailure
    }

    func start() async throws -> URL {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<URL, Error>) in
            queue.async {
                self.listen(attempt: 0, continuation: continuation)
            }
        }
    }

    private func listen(attempt: Int, continuation: CheckedContinuation<URL, Error>) {
        do {
            let parameters = NWParameters.tcp
            parameters.requiredLocalEndpoint = .hostPort(
                host: .ipv4(.loopback), port: requestedPort.map { NWEndpoint.Port(rawValue: $0)! } ?? .any)
            let listener = try NWListener(using: parameters)
            self.listener = listener
            var started = false
            var finished = false
            var retired = false
            listener.stateUpdateHandler = { state in
                guard !retired else { return }
                switch state {
                case .ready where !finished:
                    guard let port = self.listener?.port?.rawValue, port != 0 else {
                        finished = true
                        self.listener?.cancel()
                        continuation.resume(throwing: NWError.posix(.EADDRNOTAVAIL))
                        return
                    }
                    // Keep the optional controller's port available even before it starts.
                    if self.localAPI?.port == Int(port) {
                        retired = true
                        self.listener?.cancel()
                        self.listener = nil
                        if self.requestedPort == nil, attempt < 7 {
                            self.listen(attempt: attempt + 1, continuation: continuation)
                        } else {
                            continuation.resume(throwing: NWError.posix(.EADDRINUSE))
                        }
                        return
                    }
                    self.boundPort = port
                    started = true
                    finished = true
                    continuation.resume(returning: URL(string: "http://127.0.0.1:\(port)/")!)
                case .failed(let error), .waiting(let error):
                    self.listener?.cancel()
                    if !finished {
                        finished = true
                        continuation.resume(throwing: error)
                    } else if started {
                        self.onFailure(error)
                    }
                case .cancelled where !finished:
                    finished = true
                    continuation.resume(throwing: CancellationError())
                default:
                    break
                }
            }
            listener.newConnectionHandler = { self.accept($0) }
            listener.start(queue: queue)
        } catch {
            continuation.resume(throwing: error)
        }
    }

    func stop() {
        queue.async {
            self.listener?.cancel()
            self.listener = nil
            self.boundPort = nil
            for connection in self.connections.values { connection.cancel() }
            self.connections.removeAll()
        }
    }

    private func accept(_ connection: NWConnection) {
        guard connections.count < 64 else {
            connection.cancel()
            return
        }
        let id = UUID()
        connections[id] = connection
        let timeout = DispatchWorkItem { self.finish(id) }
        queue.asyncAfter(deadline: .now() + 5, execute: timeout)
        connection.stateUpdateHandler = { state in
            if case .failed = state {
                timeout.cancel()
                self.finish(id)
            }
        }
        connection.start(queue: queue)
        receive(connection, id: id, buffer: Data(), timeout: timeout)
    }

    private func receive(_ connection: NWConnection, id: UUID, buffer: Data, timeout: DispatchWorkItem) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 16_384) { data, _, complete, error in
            var buffer = buffer
            if let data { buffer.append(data) }
            if let end = buffer.range(of: Data("\r\n\r\n".utf8)) {
                self.respond(connection, id: id, header: Data(buffer[..<end.lowerBound]), timeout: timeout)
            } else if buffer.count >= 16_384 || complete || error != nil {
                timeout.cancel()
                self.finish(id)
            } else {
                self.receive(connection, id: id, buffer: buffer, timeout: timeout)
            }
        }
    }

    private func respond(_ connection: NWConnection, id: UUID, header: Data, timeout: DispatchWorkItem) {
        let lines = String(decoding: header, as: UTF8.self).components(separatedBy: "\r\n")
        let request = (lines.first ?? "").split(separator: " ")
        let host = lines.dropFirst().first { $0.lowercased().hasPrefix("host:") }?
            .dropFirst(5).trimmingCharacters(in: .whitespaces)
        guard request.count == 3, request[2] == "HTTP/1.1",
              let port = boundPort, host == "127.0.0.1:\(port)" else {
            send(connection, id: id, status: "400 Bad Request", timeout: timeout)
            return
        }
        guard request[0] == "GET" || request[0] == "HEAD" else {
            send(connection, id: id, status: "405 Method Not Allowed", timeout: timeout)
            return
        }
        let target = String(request[1])
        guard target.hasPrefix("/"), !target.hasPrefix("//"),
              let path = target.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false)
                .first?.removingPercentEncoding,
              !path.contains("\\"), !path.contains("\0"),
              !path.split(separator: "/").contains(where: { $0 == "." || $0 == ".." }) else {
            send(connection, id: id, status: "400 Bad Request", timeout: timeout)
            return
        }
        var relative = String(path.dropFirst())
        if relative.hasSuffix("/") || relative.isEmpty { relative += "index.html" }
        do {
            let body: Data
            let type: String
            if localAPI != nil && relative.hasPrefix("local/") {
                relative = "api/" + relative.dropFirst("local/".count)
            }
            let file = root.appendingPathComponent(relative).resolvingSymlinksInPath()
            guard file.path.hasPrefix(root.path + "/") else {
                send(connection, id: id, status: "403 Forbidden", timeout: timeout)
                return
            }
            if relative == "api/webapp-client.json" || relative == "collaboration/webapp-client.json" {
                guard var config = try JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? [String: Any],
                      let mode = config["mode"] as? String,
                      mode == "remote" || mode == "external" else {
                    throw CocoaError(.fileReadCorruptFile)
                }
                config["connectionPickerUrl"] = "../"
                if path == "/local/webapp-client.json", let localAPI {
                    guard mode == "remote" else { throw CocoaError(.fileReadCorruptFile) }
                    config["apiBaseUrl"] = localAPI.absoluteString
                }
                body = try JSONSerialization.data(withJSONObject: config)
                type = "application/json"
            } else {
                var directory: ObjCBool = false
                guard FileManager.default.fileExists(atPath: file.path, isDirectory: &directory),
                      !directory.boolValue else {
                    send(connection, id: id, status: "404 Not Found", timeout: timeout)
                    return
                }
                body = try Data(contentsOf: file, options: .mappedIfSafe)
                type = file.pathExtension == "js" ? "text/javascript"
                    : UTType(filenameExtension: file.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
            }
            send(connection, id: id, status: "200 OK", body: body, type: type,
                 head: request[0] == "HEAD", timeout: timeout)
        } catch {
            NSLog("Clanky could not read bundled asset %@: %@", relative, error.localizedDescription)
            send(connection, id: id, status: "500 Internal Server Error", timeout: timeout)
        }
    }

    private func send(_ connection: NWConnection, id: UUID, status: String, body: Data = Data(),
                      type: String = "text/plain", head: Bool = false, timeout: DispatchWorkItem) {
        let header = "HTTP/1.1 \(status)\r\nContent-Type: \(type)\r\nContent-Length: \(body.count)\r\n"
            + "Cache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n\r\n"
        connection.send(content: Data(header.utf8), completion: .contentProcessed { error in
            if error != nil || head || body.isEmpty {
                timeout.cancel()
                self.finish(id)
            } else {
                connection.send(content: body, completion: .contentProcessed { _ in
                    timeout.cancel()
                    self.finish(id)
                })
            }
        })
    }

    private func finish(_ id: UUID) {
        connections.removeValue(forKey: id)?.cancel()
    }
}
