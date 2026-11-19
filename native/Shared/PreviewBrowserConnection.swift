import CryptoKit
import Foundation
import Network

@MainActor
final class PreviewBrowserConnection {
    let id = UUID().uuidString
    private let connection: NWConnection
    private weak var proxy: NativePreviewProxy?
    private var buffer = Data()
    private var body = Data()
    private var headers: [[String]] = []
    private var method = ""
    private var path = ""
    private var contentLength = 0
    private var chunked = false
    private var chunkRemaining: Int?
    private var readingTrailers = false
    private var submitted = false
    private var responseStarted = false
    private var responseHasBody = true
    private var webSocket = false
    private var webSocketHandshake: String?
    private var webSocketProtocols: [String] = []
    private var fragment = Data()
    private var fragmentOpcode: UInt8?
    private var closed = false
    private var ending = false
    private var outputs: [(Data, Int, Bool)] = []
    private var outputBytes = 0
    private var writing = false
    private var timeout: DispatchWorkItem?
    private static let bodyLimit = 8 * 1024 * 1024

    init(connection: NWConnection, proxy: NativePreviewProxy) {
        self.connection = connection
        self.proxy = proxy
    }

    var bufferedBytes: Int { buffer.count + body.count + fragment.count + outputBytes }

    func start() {
        connection.stateUpdateHandler = { [weak self] state in
            Task { @MainActor in
                if case .failed(let error) = state {
                    NSLog("Clanky preview browser connection failed: %@", error.localizedDescription)
                    self?.close()
                }
            }
        }
        connection.start(queue: .main)
        read()
    }

    private func read() {
        guard !closed, !ending else { return }
        if !submitted {
            timeout?.cancel()
            let timeout = DispatchWorkItem { [weak self] in
                Task { @MainActor in self?.fail(408, "Preview request timed out.") }
            }
            self.timeout = timeout
            DispatchQueue.main.asyncAfter(deadline: .now() + 10, execute: timeout)
        }
        connection.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { [weak self] data, _, complete, error in
            Task { @MainActor in
                guard let self, !self.closed, !self.ending else { return }
                do {
                    if let data, !data.isEmpty {
                        guard (self.proxy?.bufferedBrowserBytes ?? 0) + data.count <= 16 * 1024 * 1024 else {
                            self.fail(413, "Preview browser buffer limit exceeded.")
                            return
                        }
                        self.buffer.append(data)
                        try await self.parse()
                    }
                    if error != nil || complete {
                        self.close()
                    } else {
                        self.read()
                    }
                } catch {
                    self.fail(400, "Invalid preview request: \(error.localizedDescription)")
                }
            }
        }
    }

    private func parse() async throws {
        if webSocket {
            try await parseWebSocket()
            return
        }
        guard !submitted else {
            if !buffer.isEmpty { close() }
            return
        }
        if method.isEmpty {
            guard let end = buffer.range(of: Data("\r\n\r\n".utf8)) else {
                if buffer.count > 32 * 1024 { fail(431, "Preview request headers are too large.") }
                return
            }
            guard end.lowerBound <= 32 * 1024,
                  let text = String(data: buffer[..<end.lowerBound], encoding: .utf8) else {
                throw NativePreviewFailure(message: "Invalid HTTP headers.")
            }
            consume(end.upperBound)
            try parseHeaders(text)
            guard !closed, !ending else { return }
            if webSocket {
                try await proxy?.send([
                    "type": "websocket.open", "streamId": id, "path": path,
                    "headers": headers, "acknowledgeOpen": true,
                ])
                try await parseWebSocket()
                return
            }
        }
        if chunked {
            guard try readChunkedBody() else { return }
        } else {
            guard buffer.count >= contentLength else { return }
            body = Data(buffer.prefix(contentLength))
            consume(contentLength)
        }
        guard buffer.isEmpty else { throw NativePreviewFailure(message: "HTTP pipelining is not supported.") }
        submitted = true
        timeout?.cancel()
        timeout = nil
        var message: [String: Any] = [
            "type": "request.start", "streamId": id, "method": method,
            "path": path, "headers": headers, "responseFlowControl": true,
        ]
        if !body.isEmpty { message["body"] = body.base64EncodedString() }
        body.removeAll()
        try await proxy?.send(message)
    }

    private func parseHeaders(_ text: String) throws {
        let lines = text.components(separatedBy: "\r\n")
        let request = (lines.first ?? "").split(separator: " ", omittingEmptySubsequences: false)
        guard request.count == 3, request[2] == "HTTP/1.1",
              Self.token(String(request[0])), request[1].hasPrefix("/"), !request[1].hasPrefix("//"),
              !request[1].contains("\\"), !request[1].contains("#"),
              request[1].utf8.allSatisfy({ $0 > 0x20 && $0 != 0x7f }) else {
            throw NativePreviewFailure(message: "Invalid HTTP request line.")
        }
        method = String(request[0])
        path = String(request[1])
        for line in lines.dropFirst() {
            guard let colon = line.firstIndex(of: ":") else {
                throw NativePreviewFailure(message: "Invalid HTTP header.")
            }
            let name = String(line[..<colon])
            let value = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
            guard Self.token(name), Self.headerValue(value) else {
                throw NativePreviewFailure(message: "Invalid HTTP header value.")
            }
            headers.append([name, value])
        }
        let navigation = method == "GET" && values("sec-fetch-mode") == ["navigate"]
        guard let proxy, values("host") == ["127.0.0.1:\(proxy.localURL?.port ?? 0)"],
              values("origin").allSatisfy({ $0 == proxy.localOrigin }),
              !values("sec-fetch-site").contains("cross-site") || navigation else {
            fail(403, "The preview requires its own local origin.")
            return
        }
        let lengths = values("content-length")
        let encodings = values("transfer-encoding")
        guard lengths.count <= 1, encodings.count <= 1,
              lengths.isEmpty || encodings.isEmpty else {
            throw NativePreviewFailure(message: "Ambiguous request body framing.")
        }
        if let value = lengths.first {
            guard !value.isEmpty, value.utf8.allSatisfy({ $0 >= 48 && $0 <= 57 }),
                  let length = Int(value), length <= Self.bodyLimit else {
                fail(413, "Preview request bodies are limited to 8 MiB.")
                return
            }
            contentLength = length
        }
        if let encoding = encodings.first {
            guard encoding.lowercased() == "chunked" else {
                throw NativePreviewFailure(message: "Unsupported request transfer encoding.")
            }
            chunked = true
        }
        if !values("upgrade").isEmpty {
            guard method == "GET", values("upgrade").map({ $0.lowercased() }) == ["websocket"],
                  values("connection").joined(separator: ",").lowercased()
                    .split(separator: ",").contains(where: { $0.trimmingCharacters(in: .whitespaces) == "upgrade" }),
                  values("sec-websocket-version") == ["13"],
                  values("sec-websocket-key").count == 1,
                  let key = values("sec-websocket-key").first,
                  Data(base64Encoded: key)?.count == 16,
                  contentLength == 0, !chunked else {
                throw NativePreviewFailure(message: "Invalid WebSocket handshake.")
            }
            let accept = Data(Insecure.SHA1.hash(data: Data(
                "\(key)258EAFA5-E914-47DA-95CA-C5AB0DC85B11".utf8))).base64EncodedString()
            webSocketProtocols = values("sec-websocket-protocol").flatMap {
                $0.split(separator: ",", omittingEmptySubsequences: false)
                    .map { $0.trimmingCharacters(in: .whitespaces) }
            }
            guard webSocketProtocols.allSatisfy(Self.token),
                  Set(webSocketProtocols).count == webSocketProtocols.count else {
                throw NativePreviewFailure(message: "Invalid WebSocket subprotocol.")
            }
            webSocketHandshake = "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: \(accept)\r\n"
            webSocket = true
            submitted = true
        }
        if let expectation = values("expect").first {
            guard expectation.lowercased() == "100-continue" else {
                fail(417, "Unsupported preview request expectation.")
                return
            }
            enqueue(Data("HTTP/1.1 100 Continue\r\n\r\n".utf8))
        }
    }

    private func readChunkedBody() throws -> Bool {
        while true {
            if readingTrailers {
                if buffer.starts(with: Data("\r\n".utf8)) {
                    consume(2)
                    return true
                }
                if let end = buffer.range(of: Data("\r\n\r\n".utf8)), end.upperBound <= 8192 {
                    consume(end.upperBound)
                    return true
                }
                guard buffer.count <= 8192 else { throw NativePreviewFailure(message: "Request trailers are too large.") }
                return false
            }
            if chunkRemaining == nil {
                guard let end = buffer.range(of: Data("\r\n".utf8)) else {
                    guard buffer.count <= 1024 else { throw NativePreviewFailure(message: "Invalid chunk header.") }
                    return false
                }
                let line = String(decoding: buffer[..<end.lowerBound], as: UTF8.self)
                let size = line.split(separator: ";", omittingEmptySubsequences: false).first ?? ""
                guard !size.isEmpty, size.utf8.allSatisfy({
                    (48...57).contains($0) || (65...70).contains($0) || (97...102).contains($0)
                }), let count = Int(size, radix: 16), count <= Self.bodyLimit - body.count else {
                    throw NativePreviewFailure(message: "Preview request bodies are limited to 8 MiB.")
                }
                consume(end.upperBound)
                if count == 0 { readingTrailers = true; continue }
                chunkRemaining = count
            }
            guard let count = chunkRemaining, buffer.count >= count + 2 else { return false }
            guard buffer[count] == 13, buffer[count + 1] == 10 else {
                throw NativePreviewFailure(message: "Invalid request chunk terminator.")
            }
            body.append(buffer.prefix(count))
            consume(count + 2)
            chunkRemaining = nil
        }
    }

    func receive(_ message: [String: Any]) throws {
        guard !closed, !ending, let type = message["type"] as? String else { return }
        switch type {
        case "response.start":
            guard !webSocket, !responseStarted, let status = message["status"] as? Int,
                  (200...599).contains(status), let headers = message["headers"] as? [[String]],
                  headers.allSatisfy({ $0.count == 2 && Self.token($0[0]) && Self.headerValue($0[1]) }) else {
                throw NativePreviewFailure(message: "Invalid preview HTTP response.")
            }
            responseStarted = true
            responseHasBody = method != "HEAD" && ![204, 205, 304].contains(status)
            var text = "HTTP/1.1 \(status) Preview\r\nConnection: close\r\n"
            for header in headers where !["connection", "content-length", "transfer-encoding", "trailer", "upgrade", "keep-alive"]
                .contains(header[0].lowercased()) {
                text += "\(header[0]): \(header[1])\r\n"
            }
            if responseHasBody { text += "Transfer-Encoding: chunked\r\n" }
            guard text.utf8.count <= 64 * 1024 else { throw NativePreviewFailure(message: "Preview response headers are too large.") }
            enqueue(Data("\(text)\r\n".utf8))
        case "response.body":
            guard responseStarted, !webSocket, let encoded = message["body"] as? String,
                  let bytes = Data(base64Encoded: encoded), bytes.count <= 64 * 1024 else {
                throw NativePreviewFailure(message: "Invalid preview response body.")
            }
            if responseHasBody, !bytes.isEmpty {
                var chunk = Data("\(String(bytes.count, radix: 16))\r\n".utf8)
                chunk.append(bytes)
                chunk.append(Data("\r\n".utf8))
                enqueue(chunk, acknowledge: bytes.count)
            } else if !bytes.isEmpty {
                Task { await proxy?.forward(["type": "response.ack", "streamId": id, "bytes": bytes.count]) }
            }
        case "response.end":
            guard responseStarted, !webSocket else { throw NativePreviewFailure(message: "Unexpected preview response end.") }
            enqueue(responseHasBody ? Data("0\r\n\r\n".utf8) : Data(), end: true)
        case "websocket.ready":
            guard webSocket, var response = webSocketHandshake,
                  let selected = message["protocol"] as? String,
                  selected.isEmpty || webSocketProtocols.contains(selected) else {
                throw NativePreviewFailure(message: "Invalid preview WebSocket negotiation.")
            }
            if !selected.isEmpty { response += "Sec-WebSocket-Protocol: \(selected)\r\n" }
            enqueue(Data("\(response)\r\n".utf8))
            webSocketHandshake = nil
            timeout?.cancel()
            timeout = nil
        case "websocket.message":
            guard webSocket, webSocketHandshake == nil, let encoded = message["body"] as? String,
                  let bytes = Data(base64Encoded: encoded), bytes.count <= Self.bodyLimit,
                  let binary = message["binary"] as? Bool else {
                throw NativePreviewFailure(message: "Invalid preview WebSocket message.")
            }
            enqueue(Self.frame(bytes, opcode: binary ? 2 : 1))
        case "websocket.close":
            guard webSocket else { throw NativePreviewFailure(message: "Unexpected preview WebSocket close.") }
            guard webSocketHandshake == nil else {
                fail(502, "The preview upstream WebSocket closed before opening.")
                return
            }
            let code = Self.closeCode(message["code"] as? Int ?? 1000)
            enqueue(Self.frame(Data([UInt8(code >> 8), UInt8(code & 255)]), opcode: 8), end: true)
        case "stream.error":
            fail(502, message["error"] as? String ?? "The preview request failed.")
        default:
            throw NativePreviewFailure(message: "Unknown preview response type.")
        }
    }

    private func parseWebSocket() async throws {
        guard webSocketHandshake == nil else {
            guard buffer.isEmpty else {
                throw NativePreviewFailure(message: "WebSocket data arrived before the handshake completed.")
            }
            return
        }
        while buffer.count >= 2 {
            let first = buffer[0]
            let second = buffer[1]
            let opcode = first & 15
            let final = first & 128 != 0
            guard first & 112 == 0, second & 128 != 0, [0, 1, 2, 8, 9, 10].contains(opcode) else {
                throw NativePreviewFailure(message: "Invalid browser WebSocket frame.")
            }
            var length = UInt64(second & 127)
            var offset = 2
            if length == 126 {
                guard buffer.count >= 4 else { return }
                length = UInt64(buffer[2]) << 8 | UInt64(buffer[3])
                offset = 4
            } else if length == 127 {
                guard buffer.count >= 10 else { return }
                length = buffer[2..<10].reduce(UInt64(0)) { ($0 << 8) | UInt64($1) }
                offset = 10
            }
            guard length <= Self.bodyLimit, opcode < 8 || (final && length <= 125) else {
                throw NativePreviewFailure(message: "Browser WebSocket frame is too large.")
            }
            let count = Int(length)
            guard buffer.count >= offset + 4 + count else { return }
            let mask = Array(buffer[offset..<(offset + 4)])
            offset += 4
            var payload = Data(buffer[offset..<(offset + count)])
            for index in 0..<payload.count { payload[index] ^= mask[index % 4] }
            consume(offset + count)
            if opcode == 8 {
                guard payload.count != 1 else { throw NativePreviewFailure(message: "Invalid WebSocket close.") }
                let code = payload.count >= 2 ? Int(payload[0]) << 8 | Int(payload[1]) : 1000
                try await proxy?.send(["type": "websocket.close", "streamId": id, "code": Self.closeCode(code)])
                enqueue(Self.frame(Data(), opcode: 8), end: true)
                return
            }
            if opcode == 9 { enqueue(Self.frame(payload, opcode: 10)); continue }
            if opcode == 10 { continue }
            if opcode == 0 {
                guard fragmentOpcode != nil else { throw NativePreviewFailure(message: "Unexpected WebSocket continuation.") }
            } else {
                guard fragmentOpcode == nil else { throw NativePreviewFailure(message: "Unfinished WebSocket message.") }
                fragmentOpcode = opcode
            }
            guard fragment.count + payload.count <= Self.bodyLimit else {
                throw NativePreviewFailure(message: "Browser WebSocket message is too large.")
            }
            fragment.append(payload)
            if final {
                let binary = fragmentOpcode == 2
                guard binary || String(data: fragment, encoding: .utf8) != nil else {
                    throw NativePreviewFailure(message: "Invalid WebSocket UTF-8.")
                }
                let encoded = fragment.base64EncodedString()
                fragment.removeAll()
                fragmentOpcode = nil
                try await proxy?.send(["type": "websocket.message", "streamId": id, "body": encoded, "binary": binary])
            }
        }
    }

    private func enqueue(_ data: Data, acknowledge: Int = 0, end: Bool = false) {
        guard !closed else { return }
        // Server WebSocket frames add up to 10 bytes beyond the payload limit.
        let outputLimit = webSocket ? Self.bodyLimit + 10 : 512 * 1024
        guard outputBytes + data.count <= outputLimit,
              (proxy?.bufferedBrowserBytes ?? 0) + data.count <= 16 * 1024 * 1024 else {
            NSLog("Clanky preview browser output buffer limit exceeded.")
            close()
            return
        }
        outputBytes += data.count
        outputs.append((data, acknowledge, end))
        if end { ending = true }
        write()
    }

    private func write() {
        guard !closed, !writing, !outputs.isEmpty else { return }
        writing = true
        let (data, acknowledge, end) = outputs.removeFirst()
        connection.send(content: data, completion: .contentProcessed { [weak self] error in
            Task { @MainActor in
                guard let self, !self.closed else { return }
                self.outputBytes -= data.count
                self.writing = false
                if error != nil || end {
                    self.close()
                    return
                }
                if acknowledge > 0 {
                    await self.proxy?.forward(["type": "response.ack", "streamId": self.id, "bytes": acknowledge])
                }
                self.write()
            }
        })
    }

    private func fail(_ status: Int, _ message: String) {
        guard !closed, !ending else { return }
        ending = true
        timeout?.cancel()
        timeout = nil
        NSLog("Clanky preview request failed: %@", message)
        if webSocket && webSocketHandshake == nil {
            enqueue(Self.frame(Data([0x03, 0xf3]), opcode: 8), end: true)
        } else if responseStarted {
            close()
        } else {
            responseStarted = true
            let body = Data(message.utf8)
            var response = Data("HTTP/1.1 \(status) Preview Error\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: \(body.count)\r\nConnection: close\r\n\r\n".utf8)
            response.append(body)
            enqueue(response, end: true)
        }
    }

    func close() {
        guard !closed else { return }
        closed = true
        timeout?.cancel()
        timeout = nil
        connection.stateUpdateHandler = nil
        connection.cancel()
        buffer.removeAll()
        body.removeAll()
        fragment.removeAll()
        outputs.removeAll()
        proxy?.release(id, webSocket: webSocket)
    }

    private func values(_ name: String) -> [String] {
        headers.filter { $0[0].lowercased() == name }.map { $0[1] }
    }

    private func consume(_ count: Int) {
        buffer = Data(buffer.dropFirst(count))
    }

    private static func token(_ value: String) -> Bool {
        !value.isEmpty && value.utf8.allSatisfy {
            (48...57).contains($0) || (65...90).contains($0) || (97...122).contains($0)
                || "!#$%&'*+-.^_`|~".utf8.contains($0)
        }
    }

    private static func headerValue(_ value: String) -> Bool {
        value.utf8.allSatisfy { $0 == 9 || ($0 >= 32 && $0 != 127) }
    }

    private static func closeCode(_ code: Int) -> Int {
        ((1000...1014).contains(code) && ![1004, 1005, 1006].contains(code)) || (3000...4999).contains(code) ? code : 1011
    }

    private static func frame(_ payload: Data, opcode: UInt8) -> Data {
        var result = Data([0x80 | opcode])
        if payload.count < 126 {
            result.append(UInt8(payload.count))
        } else if payload.count <= 65535 {
            result.append(contentsOf: [126, UInt8(payload.count >> 8), UInt8(payload.count & 255)])
        } else {
            result.append(127)
            let count = UInt64(payload.count)
            for shift in stride(from: 56, through: 0, by: -8) {
                result.append(UInt8((count >> shift) & 255))
            }
        }
        result.append(payload)
        return result
    }
}
