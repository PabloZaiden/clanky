import SwiftUI
import WebKit
#if os(macOS)
import AppKit
#else
import UIKit
#endif

struct PopupContent: View {
    let webView: WKWebView
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            PopupWebView(webView: webView)
                .ignoresSafeArea()
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Close") { dismiss() }
                    }
                }
        }
        #if os(macOS)
        .frame(minWidth: 600, minHeight: 400)
        #endif
    }
}

#if os(macOS)
private struct PopupWebView: NSViewRepresentable {
    let webView: WKWebView
    func makeNSView(context: Context) -> WKWebView { webView }
    func updateNSView(_ view: WKWebView, context: Context) {}
    static func dismantleNSView(_ view: WKWebView, coordinator: ()) {
        view.stopLoading()
        view.navigationDelegate = nil
        view.uiDelegate = nil
    }
}
#else
private struct PopupWebView: UIViewRepresentable {
    let webView: WKWebView
    func makeUIView(context: Context) -> WKWebView { webView }
    func updateUIView(_ view: WKWebView, context: Context) {}
    static func dismantleUIView(_ view: WKWebView, coordinator: ()) {
        view.stopLoading()
        view.navigationDelegate = nil
        view.uiDelegate = nil
    }
}
#endif

#if os(macOS)
struct WebView: NSViewRepresentable {
    @ObservedObject var browser: BrowserModel
    func makeCoordinator() -> BrowserDelegate { BrowserDelegate(browser: browser) }
    func makeNSView(context: Context) -> WKWebView { context.coordinator.attach() }
    func updateNSView(_ view: WKWebView, context: Context) {}
    static func dismantleNSView(_ view: WKWebView, coordinator: BrowserDelegate) { coordinator.stop() }
}
#else
struct WebView: UIViewRepresentable {
    @ObservedObject var browser: BrowserModel
    func makeCoordinator() -> BrowserDelegate { BrowserDelegate(browser: browser) }
    func makeUIView(context: Context) -> WebContentView {
        WebContentView(webView: context.coordinator.attach(), toolbar: browser.nativeToolbar)
    }
    func updateUIView(_ view: WebContentView, context: Context) {}
    static func dismantleUIView(_ view: WebContentView, coordinator: BrowserDelegate) { coordinator.stop() }
}

final class WebContentView: UIView {
    private var backgroundObservation: NSKeyValueObservation?
    private let toolbar: NativeToolbar

    init(webView: WKWebView, toolbar: NativeToolbar) {
        self.toolbar = toolbar
        super.init(frame: .zero)
        addSubview(webView)
        webView.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            webView.topAnchor.constraint(equalTo: topAnchor),
            webView.bottomAnchor.constraint(equalTo: bottomAnchor),
            webView.leadingAnchor.constraint(equalTo: leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: trailingAnchor),
        ])
        backgroundObservation = webView.observe(\.underPageBackgroundColor, options: [.initial, .new]) { [weak self] view, _ in
            self?.backgroundColor = view.underPageBackgroundColor
        }
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        if #available(iOS 27.1, *), window != nil, !bounds.isEmpty {
            let supported = traitCollection.verticalBarEdge != .unspecified
            let insets = safeAreaInsets
            let layout = NativeToolbarLayout(
                width: bounds.width, height: bounds.height,
                safeArea: .init(top: insets.top, right: insets.right, bottom: insets.bottom, left: insets.left),
                occlusions: reservedRegions(kind: .occlusion).map {
                    .init(x: $0.frame.minX, y: $0.frame.minY, width: $0.frame.width, height: $0.frame.height)
                }
            )
            DispatchQueue.main.async { [weak toolbar] in
                toolbar?.setSupported(supported)
                toolbar?.setLayout(layout)
            }
        }
    }

    override func safeAreaInsetsDidChange() {
        super.safeAreaInsetsDidChange()
        setNeedsLayout()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is unavailable") }
}
#endif

@MainActor
final class BrowserDelegate: NSObject, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate, WKScriptMessageHandlerWithReply {
    private let browser: BrowserModel
    private var downloads: [ObjectIdentifier: WKDownload] = [:]
    private var requestedNames: [ObjectIdentifier: String] = [:]
    private struct Transfer {
        let download: WKDownload
        let directory: URL
        let file: URL
        let destination: URL?
    }
    private var transfers: [ObjectIdentifier: Transfer] = [:]
    private var stopped = false

    init(browser: BrowserModel) { self.browser = browser }

    func attach() -> WKWebView {
        stopped = false
        browser.webView.navigationDelegate = self
        browser.webView.uiDelegate = self
        browser.webView.configuration.userContentController.addScriptMessageHandler(
            self, contentWorld: .page, name: "clankyDownloads")
        return browser.webView
    }

    func stop() {
        stopped = true
        #if os(iOS)
        browser.nativeToolbar.clear()
        #endif
        browser.webView.stopLoading()
        browser.webView.navigationDelegate = nil
        browser.webView.uiDelegate = nil
        browser.webView.configuration.userContentController.removeScriptMessageHandler(
            forName: "clankyDownloads", contentWorld: .page)
        if let popup = browser.popup?.webView {
            popup.stopLoading()
            popup.navigationDelegate = nil
            popup.uiDelegate = nil
        }
        browser.popup = nil
        for (id, download) in downloads {
            let directory = transfers[id]?.directory
            download.cancel { _ in
                if let directory { self.removeTemporaryDirectory(directory) }
            }
        }
        downloads.removeAll()
        requestedNames.removeAll()
        transfers.removeAll()
    }

    func userContentController(_ userContentController: WKUserContentController,
                               didReceive message: WKScriptMessage,
                               replyHandler: @escaping (Any?, String?) -> Void) {
        let origin = message.frameInfo.securityOrigin
        guard !stopped, message.webView === browser.webView, message.frameInfo.isMainFrame,
              origin.protocol == browser.origin.scheme, origin.host == browser.origin.host,
              origin.port == browser.origin.port,
              let path = message.frameInfo.request.url?.path,
              path.hasPrefix("/api/") || path.hasPrefix("/local/"),
              let body = message.body as? [String: Any],
              let value = body["url"] as? String, let url = URL(string: value),
              let host = url.host, url.user == nil, url.password == nil, url.fragment == nil,
              url.scheme == "https" || (url.scheme == "http" &&
                ["localhost", "127.0.0.1", "::1", "[::1]"].contains(host)),
              let name = body["suggestedName"] as? String, !name.isEmpty, name.utf8.count <= 1024 else {
            replyHandler(nil, "Invalid native download request.")
            return
        }
        browser.webView.startDownload(using: URLRequest(url: url)) { [weak self] download in
            guard let self, !self.stopped else {
                download.cancel { _ in }
                replyHandler(nil, "The native download was closed.")
                return
            }
            self.manage(download, suggestedName: name)
            replyHandler(nil, nil)
        }
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if action.shouldPerformDownload {
            decisionHandler(.download)
            return
        }
        guard let url = action.request.url else {
            decisionHandler(.cancel)
            return
        }
        if url.absoluteString == "about:blank" || action.targetFrame?.isMainFrame == false {
            decisionHandler(.allow)
        } else if url.scheme == browser.origin.scheme,
                  url.host == browser.origin.host,
                  url.port == browser.origin.port {
            decisionHandler(.allow)
        } else if ["http", "https", "mailto", "tel"].contains(url.scheme?.lowercased() ?? "") {
            decisionHandler(.cancel)
            openExternal(url)
            if webView !== browser.webView { self.webViewDidClose(webView) }
        } else {
            decisionHandler(.cancel)
            browser.error = "This link cannot be opened by Clanky."
        }
    }

    func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse,
                 decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        let disposition = (response.response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Disposition")
        decisionHandler(!response.canShowMIMEType || disposition?.lowercased().hasPrefix("attachment") == true
                        ? .download : .allow)
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        guard action.targetFrame == nil else { return nil }
        if let url = action.request.url, url.absoluteString != "about:blank" {
            openExternal(url)
            return nil
        }
        guard browser.popup == nil else {
            browser.error = "Close the open popup before opening another."
            return nil
        }
        // Content popups remain visible; authorization navigation still leaves for the system browser.
        let popup = WKWebView(frame: .zero, configuration: configuration)
        popup.navigationDelegate = self
        popup.uiDelegate = self
        browser.popup = BrowserPopup(webView: popup)
        return popup
    }

    func webViewDidClose(_ webView: WKWebView) {
        if browser.popup?.webView === webView { browser.popup = nil }
        webView.navigationDelegate = nil
        webView.uiDelegate = nil
    }

    private func openExternal(_ url: URL) {
        guard ["http", "https", "mailto", "tel"].contains(url.scheme?.lowercased() ?? "") else {
            browser.error = "This link cannot be opened by Clanky."
            return
        }
        #if os(macOS)
        if !NSWorkspace.shared.open(url) { browser.error = "Unable to open the system browser." }
        #else
        UIApplication.shared.open(url, options: [:]) { opened in
            if !opened { self.browser.error = "Unable to open the system browser." }
        }
        #endif
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        reportNavigationError(error)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        reportNavigationError(error)
    }

    private func reportNavigationError(_ error: Error) {
        guard !stopped, (error as NSError).code != NSURLErrorCancelled else { return }
        browser.error = "Unable to load the page: \(error.localizedDescription)"
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        #if os(iOS)
        browser.nativeToolbar.clear()
        #endif
        browser.error = "Clanky stopped responding. Try again to reconnect."
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        #if os(iOS)
        browser.nativeToolbar.clear()
        #endif
    }

    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        guard webView === browser.webView, let url = webView.url else { return }
        browser.rememberConnection(url)
    }

    #if os(macOS)
    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.begin { result in completionHandler(result == .OK ? panel.urls : nil) }
    }
    #endif

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        manage(download)
    }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        manage(download)
    }

    private func manage(_ download: WKDownload, suggestedName: String? = nil) {
        guard !stopped else {
            download.cancel { _ in }
            return
        }
        let id = ObjectIdentifier(download)
        downloads[id] = download
        requestedNames[id] = suggestedName
        download.delegate = self
    }

    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse,
                  suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        let id = ObjectIdentifier(download)
        let name = ((requestedNames.removeValue(forKey: id) ?? suggestedFilename) as NSString).lastPathComponent
        #if os(macOS)
        let panel = NSSavePanel()
        panel.nameFieldStringValue = name
        panel.begin { result in
            guard result == .OK, let destination = panel.url else {
                self.downloads.removeValue(forKey: id)
                completionHandler(nil)
                return
            }
            self.prepare(download, name: name, destination: destination, completionHandler: completionHandler)
        }
        #else
        prepare(download, name: name, destination: nil, completionHandler: completionHandler)
        #endif
    }

    private func prepare(_ download: WKDownload, name: String, destination: URL?,
                         completionHandler: @escaping (URL?) -> Void) {
        guard !stopped else {
            completionHandler(nil)
            return
        }
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("clanky-\(UUID().uuidString)")
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
            let file = directory.appendingPathComponent(name.isEmpty || name == "." || name == ".." ? "download" : name)
            transfers[ObjectIdentifier(download)] = Transfer(
                download: download, directory: directory, file: file, destination: destination)
            completionHandler(file)
        } catch {
            browser.error = "Unable to prepare the download: \(error.localizedDescription)"
            completionHandler(nil)
        }
    }

    func downloadDidFinish(_ download: WKDownload) {
        downloads.removeValue(forKey: ObjectIdentifier(download))
        guard let transfer = transfers.removeValue(forKey: ObjectIdentifier(download)) else { return }
        #if os(macOS)
        defer { removeTemporaryDirectory(transfer.directory) }
        do {
            guard let destination = transfer.destination else { throw CocoaError(.fileNoSuchFile) }
            if FileManager.default.fileExists(atPath: destination.path) {
                _ = try FileManager.default.replaceItemAt(destination, withItemAt: transfer.file)
            } else {
                try FileManager.default.moveItem(at: transfer.file, to: destination)
            }
        } catch {
            browser.error = "Unable to save the download: \(error.localizedDescription)"
        }
        #else
        guard let presenter = browser.webView.window?.rootViewController else {
            browser.error = "Unable to open the export sheet."
            removeTemporaryDirectory(transfer.directory)
            return
        }
        var top = presenter
        while let presented = top.presentedViewController { top = presented }
        let share = UIActivityViewController(activityItems: [transfer.file], applicationActivities: nil)
        share.popoverPresentationController?.sourceView = browser.webView
        share.popoverPresentationController?.sourceRect = CGRect(
            x: browser.webView.bounds.midX, y: browser.webView.bounds.midY, width: 1, height: 1)
        share.completionWithItemsHandler = { _, _, _, error in
            if let error { self.browser.error = "Export failed: \(error.localizedDescription)" }
            self.removeTemporaryDirectory(transfer.directory)
        }
        top.present(share, animated: true)
        #endif
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        downloads.removeValue(forKey: ObjectIdentifier(download))
        requestedNames.removeValue(forKey: ObjectIdentifier(download))
        if let transfer = transfers.removeValue(forKey: ObjectIdentifier(download)) {
            removeTemporaryDirectory(transfer.directory)
        }
        if !stopped && (error as NSError).code != NSURLErrorCancelled {
            browser.error = "Download failed: \(error.localizedDescription)"
        }
    }

    private func removeTemporaryDirectory(_ directory: URL) {
        do {
            try FileManager.default.removeItem(at: directory)
        } catch {
            NSLog("Clanky could not remove temporary download: %@", error.localizedDescription)
        }
    }
}
