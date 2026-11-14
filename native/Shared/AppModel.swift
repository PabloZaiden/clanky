import Foundation
import Network
import SwiftUI
import WebKit

@MainActor
final class AppModel: ObservableObject {
    @Published private(set) var origin: URL?
    @Published var error: String?
    private var assets: AssetServer?
    private var assetRoot: URL?
    private var assetID = UUID()
    private var assetRecovery: Task<Void, Error>?
    private var recoveryID = UUID()
    private var assetRecoveryAttempts = 0
    private var lastAssetRecovery: ContinuousClock.Instant?
    private var activeScenes: Set<UUID> = []
    #if os(iOS)
    @Published private(set) var startupMessage = "Opening Clanky..."
    @Published private(set) var updateOffer: FrontendUpdateOffer?
    @Published var updateWarning: String?
    @Published private(set) var frontendRevision = 0
    private var updateAnswer: CheckedContinuation<Bool, Never>?
    private var preparedRoot: URL?
    private var startup: Task<PreparedFrontend, Error>?
    private var startupChannel: FrontendChannel?
    private var activeChannel: FrontendChannel?
    private var channelUpdate: Task<Void, Never>?
    private var requestedChannel: FrontendChannel?
    private var channelSwitchPending = false
    #endif
    private var starting = false
    #if os(macOS)
    let controller = LocalController()
    #endif

    func start() async {
        if origin != nil {
            allowAssetRetry()
            recoverAssetsIfActive()
            return
        }
        guard assets == nil, !starting else { return }
        starting = true
        defer { starting = false }
        do {
            let savedPort = UserDefaults.standard.object(forKey: "assetServerPort")
            let port: UInt16?
            if let savedPort {
                guard let number = savedPort as? Int, number >= 1024,
                      let value = UInt16(exactly: number) else {
                    throw NSError(domain: "Clanky", code: 5, userInfo: [
                        NSLocalizedDescriptionKey: "The saved bundled UI port is invalid."
                    ])
                }
                port = value
            } else {
                port = nil
            }
            guard var root = Bundle.main.resourceURL?.appendingPathComponent("Web"),
                  FileManager.default.fileExists(atPath: root.appendingPathComponent("index.html").path),
                  FileManager.default.fileExists(atPath: root.appendingPathComponent("api/index.html").path),
                  FileManager.default.fileExists(atPath: root.appendingPathComponent("collaboration/index.html").path) else {
                throw NSError(domain: "Clanky", code: 1, userInfo: [
                    NSLocalizedDescriptionKey: "Bundled web assets are missing. Run the Apple assets build before building the app."
                ])
            }
            #if os(iOS)
            if try FrontendChannel.updatesEnabled() {
                if let preparedRoot {
                    root = preparedRoot
                } else {
                    while preparedRoot == nil {
                        let bundledRoot = root
                        let channel = try FrontendChannel.selected()
                        let previous = try FrontendChannel.applied()
                        let explicitChoice = previous != nil || channel == .latest
                        if startup == nil {
                            startupChannel = channel
                            startup = Task {
                                try await self.prepareFrontend(
                                    channel, bundledRoot: bundledRoot,
                                    fallbackChannel: previous != channel ? previous : nil,
                                    force: previous != channel,
                                    confirmDevelopment: previous == channel || (previous == nil && !explicitChoice)
                                )
                            }
                        }
                        guard let startup else { throw CancellationError() }
                        let prepared: PreparedFrontend
                        do {
                            prepared = try await startup.value
                        } catch is CancellationError {
                            self.startup = nil
                            guard try FrontendChannel.selected() != channel else { throw CancellationError() }
                            continue
                        }
                        self.startup = nil
                        guard try FrontendChannel.selected() == channel else { continue }
                        preparedRoot = prepared.root
                        updateWarning = prepared.warning
                        activeChannel = prepared.resolved ? channel : (previous ?? channel)
                        channelSwitchPending = !prepared.resolved && previous != channel && explicitChoice
                        if prepared.resolved { channel.recordApplied() }
                        root = prepared.root
                    }
                }
            }
            #endif
            assetRoot = root
            let server = makeAssetServer(root: root, port: port)
            assets = server
            let origin = try await server.start()
            guard assets === server else { throw CancellationError() }
            guard let selectedPort = origin.port else { throw NWError.posix(.EADDRNOTAVAIL) }
            UserDefaults.standard.set(selectedPort, forKey: "assetServerPort")
            error = nil
            #if os(macOS)
            await controller.refreshConnection()
            await controller.startIfEnabled()
            guard assets === server else { throw CancellationError() }
            await server.updateLocalAPI(controller.endpoint)
            #endif
            self.origin = origin
            #if os(iOS)
            if UIDevice.current.userInterfaceIdiom == .phone { NativeDiagnostics.record("app-started") }
            if try FrontendChannel.updatesEnabled(), try FrontendChannel.selected() != startupChannel {
                frontendSettingsChanged()
            }
            #endif
        } catch {
            await assets?.stop()
            assets = nil
            self.error = "Unable to open the bundled UI: \(error.localizedDescription)"
        }
    }

    private func makeAssetServer(root: URL, port: UInt16?) -> AssetServer {
        let id = UUID()
        assetID = id
        let failureHandler: @Sendable (Error) -> Void = { [weak self] failure in
            Task { @MainActor in
                guard let self, self.assetID == id else { return }
                NSLog("Clanky local UI listener stopped: %@", failure.localizedDescription)
                NativeDiagnostics.record("local-server-stopped")
                self.recoverAssetsIfActive()
            }
        }
        #if os(macOS)
        return AssetServer(root: root, port: port, localAPI: controller.endpoint, onFailure: failureHandler)
        #else
        return AssetServer(root: root, port: port, onFailure: failureHandler)
        #endif
    }

    func setScenePhase(_ phase: ScenePhase, for scene: UUID) {
        if phase == .active {
            activeScenes.insert(scene)
            #if os(iOS)
            frontendSettingsChanged()
            #endif
            recoverAssetsIfActive()
        } else {
            activeScenes.remove(scene)
            if activeScenes.isEmpty {
                assetRecovery?.cancel()
                if phase == .background {
                    assetRecoveryAttempts = 0
                    lastAssetRecovery = nil
                }
            }
        }
    }

    func allowAssetRetry() {
        assetRecoveryAttempts = 0
        lastAssetRecovery = nil
        error = nil
    }

    private func recoverAssetsIfActive() {
        guard origin != nil, !activeScenes.isEmpty else { return }
        Task { @MainActor in
            do {
                try await ensureAssets()
            } catch is CancellationError {
                return
            } catch {
                NSLog("Clanky local UI recovery failed: %@", error.localizedDescription)
                self.error = "Unable to restore the local UI: \(error.localizedDescription)"
            }
        }
    }

    func ensureAssets() async throws {
        if let assetRecovery {
            if !assetRecovery.isCancelled {
                try await assetRecovery.value
                return
            }
            let id = recoveryID
            _ = await assetRecovery.result
            if recoveryID == id { self.assetRecovery = nil }
            try Task.checkCancellation()
            try await ensureAssets()
            return
        }
        let id = UUID()
        recoveryID = id
        let recovery = Task { @MainActor in
            guard let origin = self.origin, let root = self.assetRoot,
                  let port = origin.port.flatMap(UInt16.init(exactly:)) else {
                throw NWError.posix(.ENOTCONN)
            }
            do {
                guard let server = self.assets else { throw NWError.posix(.ENOTCONN) }
                try await server.checkHealth(at: origin)
                try Task.checkCancellation()
                self.error = nil
                return
            } catch {
                try Task.checkCancellation()
                NSLog("Clanky local UI health check failed: %@", error.localizedDescription)
            }
            guard !self.activeScenes.isEmpty else { throw CancellationError() }
            if let last = self.lastAssetRecovery, last.duration(to: .now) >= .seconds(10) {
                self.assetRecoveryAttempts = 0
            }
            guard self.assetRecoveryAttempts < 2 else {
                throw NSError(domain: "Clanky", code: 7, userInfo: [
                    NSLocalizedDescriptionKey: "The local UI could not stay available. Clanky retries when you return to the app."
                ])
            }
            self.assetID = UUID()
            await self.assets?.stop()
            try Task.checkCancellation()
            self.assetRecoveryAttempts += 1
            self.lastAssetRecovery = .now
            let server = self.makeAssetServer(root: root, port: port)
            self.assets = server
            do {
                let restored = try await server.start()
                try Task.checkCancellation()
                guard self.recoveryID == id, restored == origin else { throw CancellationError() }
                try await server.checkHealth(at: origin)
                try Task.checkCancellation()
                self.error = nil
                NSLog("Clanky local UI listener recovered at its saved origin.")
                NativeDiagnostics.record("local-server-restarted")
            } catch {
                await server.stop()
                if self.assets === server { self.assets = nil }
                throw error
            }
        }
        assetRecovery = recovery
        defer {
            if recoveryID == id { assetRecovery = nil }
        }
        try await recovery.value
    }

    #if os(iOS)
    private func prepareFrontend(
        _ channel: FrontendChannel, bundledRoot: URL, installedRoot: URL? = nil,
        fallbackChannel: FrontendChannel? = nil, force: Bool, confirmDevelopment: Bool
    ) async throws -> PreparedFrontend {
        try await FrontendUpdater(storage: channel.storageDirectory(), source: channel.source).prepare(
            bundledRoot: bundledRoot, installedRoot: installedRoot,
            fallbackStorage: fallbackChannel?.storageDirectory(),
            force: force, confirmDevelopment: confirmDevelopment,
            progress: { [weak self] message in self?.startupMessage = message },
            confirm: { [weak self] offer in
                guard let self else { return false }
                return await self.confirmUpdate(offer)
            }
        )
    }

    func frontendSettingsChanged() {
        do {
            guard try FrontendChannel.updatesEnabled() else { return }
            let channel = try FrontendChannel.selected()
            guard origin != nil else {
                if let startupChannel, startupChannel != channel {
                    startup?.cancel()
                    answerUpdate(false)
                }
                return
            }
            if channelUpdate != nil {
                if requestedChannel != channel { channelUpdate?.cancel() }
                return
            }
            guard channel != activeChannel || channelSwitchPending,
                  let installedRoot = assetRoot,
                  let bundledRoot = Bundle.main.resourceURL?.appendingPathComponent("Web") else { return }
            requestedChannel = channel
            channelUpdate = Task { [weak self] in
                guard let self else { return }
                defer {
                    self.channelUpdate = nil
                    self.requestedChannel = nil
                    if !self.activeScenes.isEmpty {
                        do {
                            if try FrontendChannel.selected() != channel { self.frontendSettingsChanged() }
                        } catch {
                            self.reportChannelFailure(error)
                        }
                    }
                }
                do {
                    let prepared = try await self.prepareFrontend(
                        channel, bundledRoot: bundledRoot, installedRoot: installedRoot,
                        force: true, confirmDevelopment: false
                    )
                    try Task.checkCancellation()
                    guard prepared.resolved else {
                        self.channelSwitchPending = true
                        self.updateWarning = prepared.warning
                        return
                    }
                    try await self.ensureAssets()
                    try Task.checkCancellation()
                    guard try FrontendChannel.selected() == channel, !self.activeScenes.isEmpty else { return }
                    guard let server = self.assets else { throw NWError.posix(.ENOTCONN) }
                    // A listener replacement during the queue handoff must use the prepared root.
                    self.assetRoot = prepared.root
                    await server.updateRoot(prepared.root)
                    self.preparedRoot = prepared.root
                    self.activeChannel = channel
                    self.channelSwitchPending = false
                    channel.recordApplied()
                    self.updateWarning = prepared.warning
                    if prepared.root != installedRoot { self.frontendRevision += 1 }
                } catch is CancellationError {
                    return
                } catch {
                    self.reportChannelFailure(error)
                }
            }
        } catch {
            reportChannelFailure(error)
        }
    }

    private func reportChannelFailure(_ failure: Error) {
        channelSwitchPending = true
        NSLog("Clanky frontend channel change failed: %@", failure.localizedDescription)
        updateWarning = "Unable to change the frontend channel: \(failure.localizedDescription) Using the installed frontend."
    }

    private func confirmUpdate(_ offer: FrontendUpdateOffer) async -> Bool {
        guard !Task.isCancelled else { return false }
        return await withCheckedContinuation { continuation in
            updateAnswer = continuation
            updateOffer = offer
        }
    }

    func answerUpdate(_ update: Bool) {
        let continuation = updateAnswer
        updateAnswer = nil
        updateOffer = nil
        continuation?.resume(returning: update)
    }
    #endif

    func stopAssets() async {
        #if os(iOS)
        channelUpdate?.cancel()
        startup?.cancel()
        answerUpdate(false)
        #endif
        assetRecovery?.cancel()
        recoveryID = UUID()
        assetID = UUID()
        let server = assets
        assets = nil
        origin = nil
        await server?.stop()
    }

    #if os(macOS)
    func localControllerChanged() async {
        await assets?.updateLocalAPI(controller.endpoint)
    }
    #endif
}

@MainActor
struct BrowserPopup: Identifiable {
    let id = UUID()
    let webView: WKWebView
}

@MainActor
final class BrowserModel: ObservableObject {
    private static let connectionKey = "lastConnectionMode"
    #if os(macOS)
    private static let connectionModes = ["api", "collaboration", "local"]
    #else
    private static let connectionModes = ["api", "collaboration"]
    #endif
    let webView: WKWebView
    let origin: URL
    #if os(iOS)
    let nativeToolbar: NativeToolbar
    #endif
    @Published var error: String?
    @Published var popup: BrowserPopup?
    private var active = false
    private let ensureAssets: @MainActor () async throws -> Void
    private var assetLoad: Task<Void, Never>?
    private var assetLoadID = UUID()
    private var failedAssetPage: URL?
    private var assetNavigationRetried = false
    // A navigation waiting for the local UI; kept until it is submitted so
    // deactivation does not drop it.
    private var pendingAssetAction: ((WKWebView) -> Void)?
    // Set when the page must be reloaded without user action, e.g. after
    // WebKit terminated it or a local load failed; retried on activation.
    private var needsReload = false
    private var initialURL: URL?
    private let controllerTrust: (@MainActor (URLAuthenticationChallenge) -> (URLSession.AuthChallengeDisposition, URLCredential?)?)?

    init(origin: URL, initialURL: URL? = nil,
         controllerTrust: (@MainActor (URLAuthenticationChallenge) -> (URLSession.AuthChallengeDisposition, URLCredential?)?)? = nil,
         ensureAssets: @escaping @MainActor () async throws -> Void) {
        self.origin = origin
        self.initialURL = initialURL
        self.ensureAssets = ensureAssets
        self.controllerTrust = controllerTrust
        #if os(iOS)
        nativeToolbar = NativeToolbar(origin: origin)
        #endif
        webView = Self.makeWebView(origin: origin)
        connectNativeToolbar()
    }

    func controllerTrustDecision(_ challenge: URLAuthenticationChallenge) -> (URLSession.AuthChallengeDisposition, URLCredential?)? {
        controllerTrust?(challenge)
    }

    #if os(macOS)
    func localControllerChanged() {
        guard let path = webView.url?.path, path == "/local" || path.hasPrefix("/local/") else { return }
        withAssetsReady { $0.reloadFromOrigin() }
    }
    #endif

    private static func makeWebView(origin: URL) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        configuration.userContentController.addUserScript(WKUserScript(source: """
        window.webappNativeResourceSaver = {
          saveResource: resource => window.webkit.messageHandlers.clankyDownloads.postMessage(resource)
        };
        """, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        #if os(macOS)
        configuration.userContentController.addUserScript(WKUserScript(source: """
        window.clankyLocalController = window.location.origin === new URL("\(origin.absoluteString)").origin
          && (window.location.pathname === "/local" || window.location.pathname.startsWith("/local/"));
        """, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        #endif
        #if os(iOS)
        configuration.allowsInlineMediaPlayback = true
        if UIDevice.current.userInterfaceIdiom == .phone {
            configuration.userContentController.addUserScript(WKUserScript(
                source: "window.clankySessionDiagnosticsEnabled = true;\n" + NativeDiagnostics.storageProbe,
                injectionTime: .atDocumentStart, forMainFrameOnly: true
            ))
            configuration.userContentController.addScriptMessageHandler(
                NativeDiagnostics(origin: origin), contentWorld: .page, name: NativeDiagnostics.handlerName)
        }
        #endif
        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.allowsBackForwardNavigationGestures = true
        #if os(iOS)
        // The shared web UI owns safe areas; WebKit owns keyboard avoidance.
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        #endif
        return webView
    }

    private func connectNativeToolbar() {
        #if os(iOS)
        let view = webView
        nativeToolbar.install(in: view.configuration.userContentController)
        nativeToolbar.connect(to: view) { [weak self, weak view] message in
            guard let self, let view, view === self.webView else { return }
            self.error = message
        }
        #endif
    }

    func loadIfNeeded() {
        if let page = failedAssetPage, active, assetLoad == nil {
            failedAssetPage = nil
            load(page)
            return
        }
        guard webView.navigationDelegate != nil, webView.url == nil,
              assetLoad == nil, active else { return }
        home()
    }

    func setScenePhase(_ phase: ScenePhase) {
        active = phase == .active
        if active {
            if let pendingAssetAction, assetLoad == nil {
                error = nil
                withAssetsReady(pendingAssetAction)
            } else if needsReload, assetLoad == nil {
                reloadAutomatically()
            }
        } else {
            assetLoad?.cancel()
            assetLoadID = UUID()
            assetLoad = nil
        }
        if active { loadIfNeeded() }
    }

    func contentProcessTerminated() {
        NSLog("Clanky web content process terminated.")
        NativeDiagnostics.record("web-content-terminated")
        closePopup()
        #if os(iOS)
        nativeToolbar.clear()
        #endif
        error = nil
        needsReload = true
        if active { reloadAutomatically() }
    }

    #if os(iOS)
    func frontendChanged() {
        closePopup()
        nativeToolbar.clear()
        error = nil
        needsReload = true
        if webView.url == nil {
            home()
        } else {
            withAssetsReady { $0.reloadFromOrigin() }
        }
    }
    #endif

    private func reloadAutomatically() {
        error = nil
        if webView.url == nil {
            home()
        } else {
            withAssetsReady { $0.reload() }
        }
    }

    func navigationFinished() {
        needsReload = false
        failedAssetPage = nil
        assetNavigationRetried = false
    }

    func navigationFailed(_ failure: Error) {
        let native = failure as NSError
        let url = native.userInfo[NSURLErrorFailingURLErrorKey] as? URL
            ?? webView.url
        if native.domain == NSURLErrorDomain,
           [NSURLErrorCannotConnectToHost, NSURLErrorNetworkConnectionLost,
            NSURLErrorTimedOut, NSURLErrorNotConnectedToInternet].contains(native.code),
           let url, url.scheme == origin.scheme, url.host == origin.host, url.port == origin.port,
           !assetNavigationRetried {
            NSLog("Clanky local page load was interrupted; checking the UI listener.")
            assetNavigationRetried = true
            failedAssetPage = url
            error = nil
            loadIfNeeded()
            return
        }
        navigationFailed("Unable to load the page: \(failure.localizedDescription)")
    }

    func navigationFailed(_ message: String) {
        // Keep any pending destination so activation resumes it.
        failedAssetPage = nil
        needsReload = true
        NSLog("Clanky page navigation failed: %@", message)
        error = message
    }

    private func closePopup() {
        popup?.webView.stopLoading()
        popup?.webView.navigationDelegate = nil
        popup?.webView.uiDelegate = nil
        popup = nil
    }

    func home() {
        error = nil
        if let initialURL {
            load(initialURL)
            return
        }
        var url = origin
        if let mode = UserDefaults.standard.string(forKey: Self.connectionKey) {
            if Self.connectionModes.contains(mode) {
                url.appendPathComponent(mode + "/")
            } else {
                NSLog("Clanky discarded an unsupported saved connection mode.")
                UserDefaults.standard.removeObject(forKey: Self.connectionKey)
            }
        }
        load(url)
    }

    func load(_ url: URL) {
        withAssetsReady { view in
            view.load(URLRequest(url: url, timeoutInterval: 30))
        }
    }

    private func withAssetsReady(_ action: @escaping (WKWebView) -> Void) {
        pendingAssetAction = action
        guard active else { return }
        assetLoad?.cancel()
        let id = UUID()
        assetLoadID = id
        let view = webView
        assetLoad = Task { @MainActor [weak self, weak view] in
            guard let self, let view else { return }
            defer {
                if self.assetLoadID == id { self.assetLoad = nil }
            }
            do {
                try await self.ensureAssets()
                try Task.checkCancellation()
                guard self.active, view === self.webView, view.navigationDelegate != nil else { return }
                self.pendingAssetAction = nil
                action(view)
            } catch is CancellationError {
                return
            } catch {
                guard view === self.webView, self.active, !Task.isCancelled else { return }
                self.navigationFailed("Unable to restore the local UI: \(error.localizedDescription)")
            }
        }
    }

    func rememberConnection(_ url: URL) {
        guard url.scheme == origin.scheme,
              url.host == origin.host,
              url.port == origin.port else { return }
        initialURL = nil
        if url.path.isEmpty || url.path == "/" || url.path == "/index.html" {
            UserDefaults.standard.removeObject(forKey: Self.connectionKey)
        } else if let mode = url.pathComponents.dropFirst().first,
                  Self.connectionModes.contains(mode) {
            UserDefaults.standard.set(mode, forKey: Self.connectionKey)
        }
    }
}
