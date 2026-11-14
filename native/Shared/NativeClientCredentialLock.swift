import Foundation
import WebKit

@MainActor
final class NativeClientCredentialLock: NSObject, WKScriptMessageHandlerWithReply {
    private struct Owner: Hashable {
        let view: ObjectIdentifier
        let handler: UUID
        let page: String
    }

    private struct Lease {
        let owner: Owner
        let id: String
    }

    private struct Request {
        let lease: Lease
        weak var view: WKWebView?
        let reply: (Any?, String?) -> Void
    }

    private final class Entry {
        var active: Lease?
        var waiting: [Request] = []
        var hasValue = false
        var value: String?
    }

    private static let handlerName = "clankyClientCredentialLock"
    private static var entries: [String: Entry] = [:]
    private let origin: URL
    private weak var webView: WKWebView?
    private let viewID: ObjectIdentifier
    private let handlerID = UUID()

    private init(webView: WKWebView, origin: URL) {
        self.webView = webView
        self.viewID = ObjectIdentifier(webView)
        self.origin = origin
    }

    deinit {
        let id = viewID
        let handler = handlerID
        Task { @MainActor in Self.invalidate(view: id, handler: handler) }
    }

    static func install(in webView: WKWebView, origin: URL) {
        let controller = webView.configuration.userContentController
        controller.addScriptMessageHandler(
            NativeClientCredentialLock(webView: webView, origin: origin),
            contentWorld: .page, name: handlerName)
        controller.addUserScript(WKUserScript(source: """
        (() => {
          if (window.location.origin !== new URL("\(origin.absoluteString)").origin ||
              !/^\\/(api|local)(\\/|$)/.test(window.location.pathname)) return;
          const page = crypto.randomUUID();
          const post = body => window.webkit.messageHandlers.\(handlerName).postMessage({ ...body, page });
          window.\(handlerName) = { postMessage: post };
          window.addEventListener("pagehide", event => {
            if (!event.persisted) {
              post({ type: "depart" }).catch(error => console.error("Unable to close native credential requests.", error));
            }
          });
        })();
        """, injectionTime: .atDocumentStart, forMainFrameOnly: true))
    }

    static func contentProcessTerminated(in webView: WKWebView) {
        invalidate(view: ObjectIdentifier(webView))
    }

    private static func invalidate(view: ObjectIdentifier, handler: UUID? = nil) {
        let owners = Set(entries.values.flatMap { entry in
            ([entry.active?.owner].compactMap { $0 } + entry.waiting.map(\.lease.owner))
                .filter { $0.view == view && (handler == nil || $0.handler == handler) }
        })
        for owner in owners { invalidate(owner: owner) }
    }

    private static func invalidate(owner: Owner) {
        for entry in entries.values {
            let canceled = entry.waiting.filter { $0.lease.owner == owner }
            entry.waiting.removeAll { $0.lease.owner == owner }
            for request in canceled {
                request.reply(nil, "The authorization window closed before its request completed.")
            }
            if entry.active?.owner == owner {
                Self.invalidateActive(in: entry,
                    reason: "The window holding authorization closed before its operation completed.")
            }
        }
    }

    private static func invalidateActive(in entry: Entry, reason: String) {
        entry.active = nil
        // The owner may have saved a value without confirming it to the coordinator.
        entry.hasValue = false
        entry.value = nil
        let waiting = entry.waiting
        entry.waiting.removeAll()
        for request in waiting { request.reply(nil, reason) }
    }

    private static func grant(_ request: Request, in entry: Entry) {
        entry.active = request.lease
        var result: [String: Any] = [:]
        if entry.hasValue {
            if let value = entry.value { result["value"] = value }
            else { result["value"] = NSNull() }
        }
        request.reply(result, nil)
    }

    private static func grantNext(in entry: Entry) {
        while !entry.waiting.isEmpty {
            let request = entry.waiting.removeFirst()
            guard request.view != nil else {
                request.reply(nil, "The authorization window closed before its request completed.")
                continue
            }
            grant(request, in: entry)
            return
        }
    }

    func userContentController(_ userContentController: WKUserContentController,
                               didReceive message: WKScriptMessage,
                               replyHandler: @escaping (Any?, String?) -> Void) {
        let caller = message.frameInfo.securityOrigin
        guard let webView, message.webView === webView, message.frameInfo.isMainFrame,
              caller.protocol == origin.scheme, caller.host == origin.host,
              caller.port == origin.port,
              let path = message.frameInfo.request.url?.path,
              path == "/api" || path.hasPrefix("/api/") ||
                path == "/local" || path.hasPrefix("/local/"),
              let body = message.body as? [String: Any],
              let type = body["type"] as? String,
              let page = body["page"] as? String, UUID(uuidString: page) != nil else {
            replyHandler(nil, "Invalid native credential request.")
            return
        }
        let owner = Owner(view: viewID, handler: handlerID, page: page)
        if type == "depart" {
            Self.invalidate(owner: owner)
            replyHandler(true, nil)
            return
        }
        guard let id = body["id"] as? String, UUID(uuidString: id) != nil,
              let key = body["key"] as? String, !key.isEmpty, key.utf8.count <= 16_384 else {
            replyHandler(nil, "Invalid native credential lock.")
            return
        }
        let scopedKey = "\(origin.absoluteString)\u{0}\(key)"
        let entry = Self.entries[scopedKey] ?? Entry()
        switch type {
        case "acquire":
            guard entry.active?.id != id, !entry.waiting.contains(where: { $0.lease.id == id }) else {
                replyHandler(nil, "The native credential request is already pending.")
                return
            }
            Self.entries[scopedKey] = entry
            let request = Request(lease: Lease(owner: owner, id: id), view: webView, reply: replyHandler)
            if entry.active == nil { Self.grant(request, in: entry) }
            else { entry.waiting.append(request) }
        case "release":
            guard let active = entry.active, active.owner == owner, active.id == id else {
                replyHandler(nil, "The native credential lock belongs to another request.")
                return
            }
            guard let raw = body["value"] else {
                Self.invalidateActive(in: entry,
                    reason: "The authorization operation did not confirm its saved credentials.")
                replyHandler(true, nil)
                return
            }
            if raw is NSNull {
                entry.value = nil
            } else if let value = raw as? String, value.utf8.count <= 1_048_576 {
                entry.value = value
            } else {
                replyHandler(nil, "Invalid saved credential snapshot.")
                return
            }
            entry.hasValue = true
            entry.active = nil
            Self.grantNext(in: entry)
            replyHandler(true, nil)
        case "cancel":
            if let index = entry.waiting.firstIndex(where: { $0.lease.owner == owner && $0.lease.id == id }) {
                let request = entry.waiting.remove(at: index)
                request.reply(nil, "The native credential request was canceled.")
            }
            replyHandler(true, nil)
        default:
            replyHandler(nil, "Unsupported native credential request.")
        }
    }
}
