import SwiftUI
import WebKit
#if os(macOS)
import AppKit
#else
import UIKit
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
final class BrowserDelegate: NSObject, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate {
    private let browser: BrowserModel
    private var popups: [WKWebView] = []
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
        for popup in popups {
            popup.stopLoading()
            popup.navigationDelegate = nil
            popup.uiDelegate = nil
        }
        popups.removeAll()
        for transfer in transfers.values {
            transfer.download.cancel { _ in
                self.removeTemporaryDirectory(transfer.directory)
            }
        }
        transfers.removeAll()
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
        // The existing device login preopens a blank window, then assigns its authorization URL.
        let popup = WKWebView(frame: .zero, configuration: configuration)
        popup.navigationDelegate = self
        popup.uiDelegate = self
        popups.append(popup)
        return popup
    }

    func webViewDidClose(_ webView: WKWebView) {
        popups.removeAll { $0 === webView }
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
        download.delegate = self
    }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        download.delegate = self
    }

    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse,
                  suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        let name = (suggestedFilename as NSString).lastPathComponent
        #if os(macOS)
        let panel = NSSavePanel()
        panel.nameFieldStringValue = name
        panel.begin { result in
            guard result == .OK, let destination = panel.url else {
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
