import Foundation
import SwiftUI
import WebKit
#if os(macOS)
import AppKit
#else
import SafariServices
import UIKit
#endif

@MainActor
final class NativePreviews: NSObject, WKScriptMessageHandlerWithReply {
    private let origin: URL
    private weak var webView: WKWebView?
    private let trust: @MainActor (URLAuthenticationChallenge) -> (URLSession.AuthChallengeDisposition, URLCredential?)?
    private var previews: [String: NativePreviewProxy] = [:]
    private var activePage: String?
    #if os(iOS)
    private var backgroundTask = UIBackgroundTaskIdentifier.invalid
    private var backgrounded = false
    #endif

    init(origin: URL,
         trust: @escaping @MainActor (URLAuthenticationChallenge) -> (URLSession.AuthChallengeDisposition, URLCredential?)?) {
        self.origin = origin
        self.trust = trust
        super.init()
        #if os(iOS)
        NotificationCenter.default.addObserver(self, selector: #selector(applicationBackgrounded),
                                              name: UIApplication.didEnterBackgroundNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(applicationForegrounded),
                                              name: UIApplication.willEnterForegroundNotification, object: nil)
        #endif
    }

    func install(in webView: WKWebView) {
        self.webView = webView
        let controller = webView.configuration.userContentController
        controller.addScriptMessageHandler(self, contentWorld: .page, name: "clankyPreviews")
        #if os(macOS)
        let platform = "macos"
        #else
        let platform = "ios"
        #endif
        controller.addUserScript(WKUserScript(source: """
        (() => {
          if (location.origin !== new URL("\(origin.absoluteString)").origin ||
              !/^\\/(api|local)(\\/|$)/.test(location.pathname)) return;
          const page = crypto.randomUUID();
          const postMessage = body => window.webkit.messageHandlers.clankyPreviews.postMessage({ ...body, page });
          window.clankyPreviews = { platform: "\(platform)", postMessage };
          const attach = () => postMessage({ type: "attach" })
            .catch(error => console.error("Unable to initialize local previews.", error));
          attach();
          window.addEventListener("pageshow", event => {
            if (event.persisted) attach();
          });
          window.addEventListener("pagehide", () => {
            postMessage({ type: "reset" }).catch(error => console.error("Unable to close local previews.", error));
          });
        })();
        """, injectionTime: .atDocumentStart, forMainFrameOnly: true))
    }

    func stopAll(_ reason: String, remove: Bool = true) {
        let existing = Array(previews.values)
        if remove { previews.removeAll() }
        for preview in existing { preview.stop(reason) }
        changed()
    }

    func documentClosed(_ reason: String) {
        activePage = nil
        stopAll(reason)
    }

    func setScenePhase(_ phase: ScenePhase) {
        #if os(iOS)
        if phase == .active {
            backgrounded = false
            endBackgroundTask()
            changed()
        } else if phase == .background, UIApplication.shared.applicationState == .background, !backgrounded {
            backgrounded = true
            guard previews.values.contains(where: { $0.status == "active" || $0.status == "starting" }) else { return }
            backgroundTask = UIApplication.shared.beginBackgroundTask(withName: "Finish Clanky preview activity") { [weak self] in
                Task { @MainActor in
                    self?.stopAll("iOS ended background preview activity. Start the preview again in Clanky.", remove: false)
                    self?.endBackgroundTask()
                }
            }
            if backgroundTask == .invalid {
                stopAll("iOS did not allow background preview activity. Start the preview again in Clanky.", remove: false)
            }
        }
        #endif
    }

    #if os(iOS)
    @objc private func applicationBackgrounded() { setScenePhase(.background) }
    @objc private func applicationForegrounded() { setScenePhase(.active) }

    private func endBackgroundTask() {
        guard backgroundTask != .invalid else { return }
        let task = backgroundTask
        backgroundTask = .invalid
        UIApplication.shared.endBackgroundTask(task)
    }
    #endif

    private func changed() {
        #if os(iOS)
        if !previews.values.contains(where: { $0.status == "active" || $0.status == "starting" }) {
            endBackgroundTask()
        }
        #endif
        guard let webView, let url = webView.url, url.scheme == origin.scheme,
              url.host == origin.host, url.port == origin.port,
              url.path == "/api" || url.path.hasPrefix("/api/") ||
                url.path == "/local" || url.path.hasPrefix("/local/") else { return }
        webView.callAsyncJavaScript(
            "window.dispatchEvent(new CustomEvent('clanky-previews-changed', { detail: previews }));",
            arguments: ["previews": previews.values.map(\.snapshot)], in: nil, in: .page
        ) { result in
            if case .failure(let failure) = result {
                NSLog("Clanky could not publish local preview state: %@", failure.localizedDescription)
            }
        }
    }

    func userContentController(_ userContentController: WKUserContentController,
                               didReceive message: WKScriptMessage,
                               replyHandler: @escaping (Any?, String?) -> Void) {
        let caller = message.frameInfo.securityOrigin
        guard let webView, message.webView === webView, message.frameInfo.isMainFrame,
              caller.protocol == origin.scheme, caller.host == origin.host, caller.port == origin.port,
              let path = message.frameInfo.request.url?.path,
              path == "/api" || path.hasPrefix("/api/") ||
                path == "/local" || path.hasPrefix("/local/"),
              let body = message.body as? [String: Any], let type = body["type"] as? String,
              let page = body["page"] as? String, UUID(uuidString: page) != nil else {
            replyHandler(nil, "Invalid native preview request.")
            return
        }
        if type == "attach" {
            if activePage != page { stopAll("The owning Clanky document changed.") }
            activePage = page
            replyHandler(true, nil)
            return
        }
        Task { @MainActor [self] in
            do {
                guard activePage == page else {
                    throw NativePreviewFailure(message: "The owning Clanky document is no longer active.")
                }
                switch type {
                case "list":
                    replyHandler(previews.values.filter { $0.page == page }.map(\.snapshot), nil)
                case "reset":
                    let owned = previews.values.filter { $0.page == page }
                    for preview in owned {
                        previews.removeValue(forKey: preview.id)
                        preview.stop("The owning Clanky session closed.")
                    }
                    changed()
                    replyHandler(true, nil)
                case "start":
                    #if os(iOS)
                    guard !backgrounded else {
                        throw NativePreviewFailure(message: "Return to Clanky before starting a preview.")
                    }
                    #endif
                    guard previews.count < 8,
                          let target = body["target"] as? [String: String], target.count == 2,
                          ["workspace", "server"].contains(target["kind"] ?? ""),
                          let reference = target["reference"], !reference.isEmpty, reference.utf8.count <= 16_384,
                          let number = body["port"] as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
                          number.doubleValue == Double(number.intValue), (1...65535).contains(number.intValue),
                          let initialPath = body["path"] as? String, initialPath.hasPrefix("/"),
                          !initialPath.hasPrefix("//"), !initialPath.contains("\\"),
                          initialPath.utf8.count <= 8192,
                          initialPath.utf8.allSatisfy({ $0 >= 32 && $0 != 127 }),
                          let upstreamProtocol = body["protocol"] as? String, ["http", "https"].contains(upstreamProtocol),
                          let rawURL = body["socketUrl"] as? String, let url = URLComponents(string: rawURL),
                          let host = url.host, url.user == nil, url.password == nil, url.fragment == nil,
                          url.scheme == "wss" || (url.scheme == "ws" && ["localhost", "127.0.0.1", "::1"].contains(host)),
                          url.path.hasSuffix("/api/previews/bridge"), url.queryItems?.count == 1,
                          let ticket = url.queryItems?.first, ticket.name == "webapp_ticket",
                          let value = ticket.value, !value.isEmpty, value.utf8.count <= 1024,
                          let socketURL = url.url else {
                        throw NativePreviewFailure(message: "Invalid preview options or local preview capacity reached.")
                    }
                    let preview = NativePreviewProxy(
                        page: page, target: target, port: number.intValue, path: initialPath,
                        upstreamProtocol: upstreamProtocol, socketURL: socketURL, origin: origin,
                        trust: trust, changed: { [weak self] in self?.changed() })
                    previews[preview.id] = preview
                    changed()
                    try await preview.start()
                    guard activePage == page, previews[preview.id] === preview else {
                        preview.stop("The owning Clanky session changed.")
                        throw NativePreviewFailure(message: "The owning Clanky session changed.")
                    }
                    replyHandler(preview.snapshot, nil)
                case "close", "open":
                    guard let id = body["id"] as? String, let preview = previews[id], preview.page == page else {
                        throw NativePreviewFailure(message: "This preview belongs to another window or is no longer available.")
                    }
                    if type == "close" {
                        previews.removeValue(forKey: id)
                        preview.stop("Preview closed from the app.")
                        changed()
                    } else {
                        guard preview.status == "active", let url = preview.localURL else {
                            throw NativePreviewFailure(message: "Start the interrupted preview again before opening it.")
                        }
                        #if os(macOS)
                        guard NSWorkspace.shared.open(url) else {
                            throw NativePreviewFailure(message: "Unable to open the system browser.")
                        }
                        #else
                        guard var presenter = webView.window?.rootViewController else {
                            throw NativePreviewFailure(message: "The preview browser cannot be presented from this window.")
                        }
                        while let presented = presenter.presentedViewController { presenter = presented }
                        guard !presenter.isBeingDismissed, !(presenter is SFSafariViewController) else {
                            throw NativePreviewFailure(message: "Close the current browser before opening another preview.")
                        }
                        presenter.present(SFSafariViewController(url: url), animated: true)
                        #endif
                    }
                    replyHandler(true, nil)
                default:
                    throw NativePreviewFailure(message: "Unknown native preview operation.")
                }
            } catch {
                NSLog("Clanky native preview operation failed: %@", error.localizedDescription)
                replyHandler(nil, error.localizedDescription)
            }
        }
    }
}
