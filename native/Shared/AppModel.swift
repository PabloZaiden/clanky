import Foundation
import Network
import SwiftUI
import WebKit

@MainActor
final class AppModel: ObservableObject {
    @Published private(set) var origin: URL?
    @Published var error: String?
    private var assets: AssetServer?
    #if os(macOS)
    let controller = LocalController()
    #endif

    func start() async {
        guard assets == nil else { return }
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
            guard let root = Bundle.main.resourceURL?.appendingPathComponent("Web"),
                  FileManager.default.fileExists(atPath: root.appendingPathComponent("index.html").path),
                  FileManager.default.fileExists(atPath: root.appendingPathComponent("api/index.html").path),
                  FileManager.default.fileExists(atPath: root.appendingPathComponent("collaboration/index.html").path) else {
                throw NSError(domain: "Clanky", code: 1, userInfo: [
                    NSLocalizedDescriptionKey: "Bundled web assets are missing. Run the Apple assets build before building the app."
                ])
            }
            let failureHandler: @Sendable (Error) -> Void = { [weak self] failure in
                Task { @MainActor in
                    self?.stopAssets()
                    self?.error = "The bundled UI server stopped: \(failure.localizedDescription)"
                }
            }
            #if os(macOS)
            let server = AssetServer(root: root, port: port, localAPI: LocalController.endpoint, onFailure: failureHandler)
            #else
            let server = AssetServer(root: root, port: port, onFailure: failureHandler)
            #endif
            assets = server
            let origin = try await server.start()
            guard let selectedPort = origin.port else { throw NWError.posix(.EADDRNOTAVAIL) }
            UserDefaults.standard.set(selectedPort, forKey: "assetServerPort")
            error = nil
            self.origin = origin
        } catch {
            assets?.stop()
            assets = nil
            self.error = "Unable to open the bundled UI: \(error.localizedDescription)"
        }
    }

    func stopAssets() {
        assets?.stop()
        assets = nil
        origin = nil
    }
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

    init(origin: URL) {
        self.origin = origin
        #if os(iOS)
        nativeToolbar = NativeToolbar(origin: origin)
        #endif
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        configuration.userContentController.addUserScript(WKUserScript(source: """
        window.webappNativeResourceSaver = {
          saveResource: resource => window.webkit.messageHandlers.clankyDownloads.postMessage(resource)
        };
        """, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        #if os(iOS)
        configuration.allowsInlineMediaPlayback = true
        nativeToolbar.install(in: configuration.userContentController)
        #endif
        webView = WKWebView(frame: .zero, configuration: configuration)
        webView.allowsBackForwardNavigationGestures = true
        #if os(iOS)
        // The shared web UI owns safe areas; WebKit owns keyboard avoidance.
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        nativeToolbar.connect(to: webView) { [weak self] message in self?.error = message }
        #endif
    }

    func home() {
        error = nil
        var url = origin
        if let mode = UserDefaults.standard.string(forKey: Self.connectionKey) {
            if Self.connectionModes.contains(mode) {
                url.appendPathComponent(mode + "/")
            } else {
                NSLog("Clanky discarded an unsupported saved connection mode.")
                UserDefaults.standard.removeObject(forKey: Self.connectionKey)
            }
        }
        webView.load(URLRequest(url: url))
    }

    func rememberConnection(_ url: URL) {
        guard url.scheme == origin.scheme,
              url.host == origin.host,
              url.port == origin.port else { return }
        if url.path.isEmpty || url.path == "/" || url.path == "/index.html" {
            UserDefaults.standard.removeObject(forKey: Self.connectionKey)
        } else if let mode = url.pathComponents.dropFirst().first,
                  Self.connectionModes.contains(mode) {
            UserDefaults.standard.set(mode, forKey: Self.connectionKey)
        }
    }

    func reload() {
        error = nil
        if webView.url == nil { home() } else { webView.reload() }
    }
}
