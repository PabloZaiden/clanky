import CryptoKit
import Foundation

struct FrontendUpdateOffer: Identifiable, Sendable {
    let id = UUID()
    let currentVersion: String
    let version: String
    let revision: String
}

struct PreparedFrontend: Sendable {
    let root: URL
    let warning: String?
}

actor FrontendUpdater {
    private struct UpdateReference: Codable, Sendable {
        let manifest: String
        let bytes: Int
        let sha256: String
    }

    private struct BuildInfo: Codable, Sendable {
        let revision: String
        let version: String
        let builtAt: String
        let update: UpdateReference
    }

    private struct Asset: Decodable, Sendable {
        let path: String
        let bytes: Int
        let sha256: String
    }

    private struct Manifest: Decodable, Sendable {
        let revision: String
        let version: String
        let files: [Asset]
    }

    private struct Snapshot: Sendable {
        let root: URL
        let info: BuildInfo
        let manifest: Manifest
    }

    private struct Selection: Codable {
        let bundled: String
        let active: String
        let previous: String?
    }

    private struct UpdateError: LocalizedError {
        let message: String
        var errorDescription: String? { message }
    }

    private static let requiredPaths: Set<String> = [
        "index.html", "api/index.html", "api/webapp-client.json",
        "collaboration/index.html", "collaboration/webapp-client.json",
    ]
    private let source: URL
    private let storage: URL
    private let session: URLSession
    private let files = FileManager.default

    init(storage: URL, source: URL = URL(string: "https://pablozaiden.github.io/clanky/")!) {
        self.storage = storage
        self.source = source
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil
        configuration.urlCredentialStorage = nil
        configuration.urlCache = nil
        configuration.timeoutIntervalForRequest = 10
        configuration.timeoutIntervalForResource = 30
        session = URLSession(configuration: configuration)
    }

    func prepare(
        bundledRoot: URL,
        progress: @escaping @MainActor @Sendable (String) -> Void,
        confirm: @escaping @MainActor @Sendable (FrontendUpdateOffer) async -> Bool
    ) async throws -> PreparedFrontend {
        defer { session.invalidateAndCancel() }
        let bundled = try loadSnapshot(bundledRoot)
        var current = bundled
        var warnings: [String] = []
        func report(_ message: String) {
            NSLog("Clanky frontend update: %@", message)
            warnings.append(message)
        }
        do {
            let selectionFile = storage.appendingPathComponent("selection.json")
            if files.fileExists(atPath: selectionFile.path) {
                let selection = try JSONDecoder().decode(Selection.self, from: read(selectionFile, limit: 4096))
                guard isHash(selection.bundled), isHash(selection.active),
                      selection.previous.map({ isHash($0) }) ?? true else {
                    throw UpdateError(message: "The saved frontend selection is invalid.")
                }
                // A newly installed app's bundled frontend supersedes an older app's selection.
                if selection.bundled == bundled.info.update.sha256 {
                    do {
                        current = try savedSnapshot(selection.active)
                    } catch {
                        report("Unable to restore the active frontend: \(error.localizedDescription)")
                        if let previous = selection.previous {
                            current = try savedSnapshot(previous)
                        }
                    }
                }
            }
        } catch {
            report("Unable to restore the saved frontend: \(error.localizedDescription) Using the bundled frontend.")
            current = bundled
        }
        do {
            if files.fileExists(atPath: storage.path) {
                for child in try files.contentsOfDirectory(at: storage, includingPropertiesForKeys: nil) {
                    if child.lastPathComponent.hasPrefix("staging-"),
                       UUID(uuidString: String(child.lastPathComponent.dropFirst(8))) != nil {
                        try files.removeItem(at: child)
                    }
                }
            }
        } catch {
            report("Unable to remove incomplete frontend updates: \(error.localizedDescription)")
        }

        do {
            await progress("Checking for frontend updates...")
            let info = try await deadline(seconds: 5) { try await self.deployment() }
            let development = current.info.version.hasSuffix("-development")
            let samePublishedRevision = !development && info.revision == current.info.revision
            if info.update.sha256 != current.info.update.sha256 && !samePublishedRevision {
                if development {
                    let offer = FrontendUpdateOffer(
                        currentVersion: current.info.version, version: info.version, revision: info.revision
                    )
                    guard await confirm(offer) else {
                        return PreparedFrontend(root: current.root, warning: warnings.isEmpty ? nil : warnings.joined(separator: "\n"))
                    }
                }
                let installed = current
                let updated = try await deadline(seconds: 120) {
                    try await self.install(info, current: installed, bundled: bundled, progress: progress)
                }
                let selection = Selection(
                    bundled: bundled.info.update.sha256, active: info.update.sha256,
                    previous: current.root == bundled.root ? nil : current.info.update.sha256
                )
                try JSONEncoder().encode(selection).write(
                    to: storage.appendingPathComponent("selection.json"), options: .atomic
                )
                current = updated
                do {
                    let retained = Set([selection.active, selection.previous].compactMap { $0 })
                    for child in try files.contentsOfDirectory(at: storage, includingPropertiesForKeys: nil) {
                        if isHash(child.lastPathComponent), !retained.contains(child.lastPathComponent) {
                            try files.removeItem(at: child)
                        }
                    }
                } catch {
                    report("The frontend was updated, but old update files could not be removed: \(error.localizedDescription)")
                }
            }
        } catch {
            report("Unable to update the frontend: \(error.localizedDescription) Using the installed frontend.")
        }
        return PreparedFrontend(root: current.root, warning: warnings.isEmpty ? nil : warnings.joined(separator: "\n"))
    }

    private func deployment() async throws -> BuildInfo {
        let data = try await downloadData("build-info.json", limit: 65_536)
        let info = try JSONDecoder().decode(BuildInfo.self, from: data)
        try validate(info)
        return info
    }

    private func install(
        _ info: BuildInfo, current: Snapshot, bundled: Snapshot,
        progress: @escaping @MainActor @Sendable (String) -> Void
    ) async throws -> Snapshot {
        let manifestData = try await downloadData(info.update.manifest, limit: info.update.bytes)
        let manifest = try decodeManifest(manifestData, info: info)
        try files.createDirectory(at: storage, withIntermediateDirectories: true)
        let staging = storage.appendingPathComponent("staging-\(UUID().uuidString)")
        try files.createDirectory(at: staging, withIntermediateDirectories: false)
        defer {
            if files.fileExists(atPath: staging.path) {
                do { try files.removeItem(at: staging) }
                catch { NSLog("Clanky could not remove frontend staging files: %@", error.localizedDescription) }
            }
        }

        var candidates: [String: URL] = [:]
        for snapshot in [bundled, current] {
            for asset in snapshot.manifest.files {
                candidates[asset.sha256] = snapshot.root.appendingPathComponent(asset.path)
            }
        }
        var verified: [String: URL] = [:]
        for (index, asset) in manifest.files.enumerated() {
            try Task.checkCancellation()
            await progress("Updating frontend... \(index + 1)/\(manifest.files.count)")
            let destination = staging.appendingPathComponent(asset.path)
            try files.createDirectory(at: destination.deletingLastPathComponent(), withIntermediateDirectories: true)
            if verified[asset.sha256] == nil, let candidate = candidates[asset.sha256] {
                do {
                    try verify(candidate, asset: asset)
                    verified[asset.sha256] = candidate
                } catch {
                    NSLog("Clanky could not reuse frontend asset %@: %@", asset.path, error.localizedDescription)
                }
            }
            if let local = verified[asset.sha256] {
                try files.copyItem(at: local, to: destination)
            } else {
                let temporary = try await download(asset.path, limit: asset.bytes)
                defer { removeDownload(temporary) }
                try verify(temporary, asset: asset)
                try files.moveItem(at: temporary, to: destination)
                verified[asset.sha256] = destination
            }
        }
        try manifestData.write(to: staging.appendingPathComponent("frontend-update.json"), options: .atomic)
        try JSONEncoder().encode(info).write(to: staging.appendingPathComponent("build-info.json"), options: .atomic)
        try Task.checkCancellation()
        let target = storage.appendingPathComponent(info.update.sha256)
        if files.fileExists(atPath: target.path) {
            try files.removeItem(at: target)
        }
        try files.moveItem(at: staging, to: target)
        return Snapshot(root: target, info: info, manifest: manifest)
    }

    private func loadSnapshot(_ root: URL) throws -> Snapshot {
        let info = try JSONDecoder().decode(BuildInfo.self, from: read(root.appendingPathComponent("build-info.json"), limit: 65_536))
        try validate(info)
        let manifest = try decodeManifest(read(root.appendingPathComponent(info.update.manifest), limit: info.update.bytes), info: info)
        for path in Self.requiredPaths {
            let values = try root.appendingPathComponent(path).resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey])
            guard values.isRegularFile == true, values.isSymbolicLink != true else {
                throw UpdateError(message: "The installed frontend is missing \(path).")
            }
        }
        return Snapshot(root: root, info: info, manifest: manifest)
    }

    private func savedSnapshot(_ identity: String) throws -> Snapshot {
        let snapshot = try loadSnapshot(storage.appendingPathComponent(identity))
        guard snapshot.info.update.sha256 == identity else {
            throw UpdateError(message: "The saved frontend identity is invalid.")
        }
        return snapshot
    }

    private func validate(_ info: BuildInfo) throws {
        guard isHash(info.revision, length: 40), !info.version.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              !info.builtAt.isEmpty, info.update.manifest == "frontend-update.json",
              isHash(info.update.sha256), info.update.bytes > 0, info.update.bytes <= 8_388_608 else {
            throw UpdateError(message: "The frontend build metadata is invalid.")
        }
    }

    private func decodeManifest(_ data: Data, info: BuildInfo) throws -> Manifest {
        guard data.count == info.update.bytes, digest(data) == info.update.sha256 else {
            throw UpdateError(message: "The frontend manifest failed integrity verification.")
        }
        let manifest = try JSONDecoder().decode(Manifest.self, from: data)
        guard manifest.revision == info.revision, manifest.version == info.version,
              !manifest.files.isEmpty, manifest.files.count <= 10_000 else {
            throw UpdateError(message: "The frontend manifest does not describe this build.")
        }
        var paths = Set<String>()
        var sizes: [String: Int] = [:]
        var total = 0
        for asset in manifest.files {
            let components = asset.path.components(separatedBy: "/")
            let canonical = asset.path.precomposedStringWithCanonicalMapping.lowercased()
            guard !components.contains(where: { $0.isEmpty || $0 == "." || $0 == ".." }),
                  !asset.path.contains("\\"), !asset.path.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains),
                  asset.path.utf8.count <= 4096, canonical != "build-info.json", canonical != "frontend-update.json",
                  paths.insert(canonical).inserted, isHash(asset.sha256),
                  sizes[asset.sha256].map({ $0 == asset.bytes }) ?? true,
                  asset.bytes >= 0, asset.bytes <= 1_000_000_000 - total else {
                throw UpdateError(message: "The frontend manifest contains an invalid asset.")
            }
            sizes[asset.sha256] = asset.bytes
            total += asset.bytes
        }
        guard Self.requiredPaths.isSubset(of: Set(manifest.files.map(\.path))) else {
            throw UpdateError(message: "The frontend manifest is missing required application files.")
        }
        return manifest
    }

    private func read(_ url: URL, limit: Int) throws -> Data {
        let values = try url.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey])
        guard values.isRegularFile == true, values.isSymbolicLink != true,
              let size = values.fileSize, size <= limit else {
            throw UpdateError(message: "A frontend file has an invalid type or size.")
        }
        return try Data(contentsOf: url)
    }

    private func verify(_ url: URL, asset: Asset) throws {
        let values = try url.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey])
        guard values.isRegularFile == true, values.isSymbolicLink != true, values.fileSize == asset.bytes else {
            throw UpdateError(message: "Frontend asset \(asset.path) has an invalid type or size.")
        }
        let handle = try FileHandle(forReadingFrom: url)
        defer {
            do { try handle.close() }
            catch { NSLog("Clanky could not close a frontend asset: %@", error.localizedDescription) }
        }
        var hasher = SHA256()
        while let chunk = try handle.read(upToCount: 1_048_576), !chunk.isEmpty {
            hasher.update(data: chunk)
        }
        guard hasher.finalize().map({ String(format: "%02x", $0) }).joined() == asset.sha256 else {
            throw UpdateError(message: "Frontend asset \(asset.path) failed integrity verification.")
        }
    }

    private func isHash(_ value: String, length: Int = 64) -> Bool {
        value.utf8.count == length && value.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
    }

    private func digest(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    private func downloadData(_ path: String, limit: Int) async throws -> Data {
        let file = try await download(path, limit: limit)
        defer { removeDownload(file) }
        return try read(file, limit: limit)
    }

    private func download(_ path: String, limit: Int) async throws -> URL {
        var request = URLRequest(url: source.appendingPathComponent(path), cachePolicy: .reloadIgnoringLocalAndRemoteCacheData)
        request.setValue("no-cache", forHTTPHeaderField: "Cache-Control")
        let delegate = FrontendDownloadDelegate(source: source, limit: limit)
        let (file, response) = try await session.download(for: request, delegate: delegate)
        do {
            guard let response = response as? HTTPURLResponse, response.statusCode == 200,
                  let url = response.url, delegate.allows(url) else {
                throw UpdateError(message: "Frontend download \(path) returned an invalid response (HTTP \((response as? HTTPURLResponse)?.statusCode ?? 0)).")
            }
            guard (try file.resourceValues(forKeys: [.fileSizeKey])).fileSize.map({ $0 <= limit }) == true else {
                throw UpdateError(message: "Frontend download \(path) exceeded its expected size.")
            }
            return file
        } catch {
            removeDownload(file)
            throw error
        }
    }

    private func removeDownload(_ file: URL) {
        guard files.fileExists(atPath: file.path) else { return }
        do { try files.removeItem(at: file) }
        catch { NSLog("Clanky could not remove a frontend download: %@", error.localizedDescription) }
    }

    private func deadline<T: Sendable>(
        seconds: UInt64, operation: @escaping @Sendable () async throws -> T
    ) async throws -> T {
        try await withThrowingTaskGroup(of: T.self) { group in
            group.addTask(operation: operation)
            group.addTask {
                try await Task.sleep(nanoseconds: seconds * 1_000_000_000)
                throw URLError(.timedOut)
            }
            defer { group.cancelAll() }
            guard let result = try await group.next() else { throw CancellationError() }
            return result
        }
    }
}

private final class FrontendDownloadDelegate: NSObject, URLSessionDownloadDelegate, @unchecked Sendable {
    private let source: URL
    private let limit: Int

    init(source: URL, limit: Int) {
        self.source = source
        self.limit = limit
    }

    func allows(_ url: URL) -> Bool {
        url.scheme == source.scheme && url.host == source.host && url.port == source.port
            && url.path.hasPrefix(source.path) && url.user == nil && url.password == nil
    }

    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(request.url.map(allows) == true ? request : nil)
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask,
                    didWriteData bytesWritten: Int64, totalBytesWritten: Int64, totalBytesExpectedToWrite: Int64) {
        if totalBytesWritten > Int64(limit) || totalBytesExpectedToWrite > Int64(limit) {
            downloadTask.cancel()
        }
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {}
}
