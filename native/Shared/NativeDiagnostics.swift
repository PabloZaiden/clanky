import Foundation
import WebKit

/// iPhone-only lifecycle history kept outside WebKit storage, so it survives
/// when the page's local storage is lost.
@MainActor
final class NativeDiagnostics: NSObject, WKScriptMessageHandlerWithReply {
    private let origin: URL

    init(origin: URL) { self.origin = origin }

    static let handlerName = "clankyNativeDiagnostics"
    private static let historyKey = "nativeDiagnostics"
    private static let markerSeenKey = "webStorageMarkerSeen"
    private static let limit = 20

    static let storageProbe = """
    (() => {
      const post = body => window.webkit.messageHandlers.\(handlerName).postMessage(body).catch(() => {});
      try {
        const key = "clanky.native-storage-marker";
        const present = localStorage.getItem(key) !== null;
        if (!present) localStorage.setItem(key, "1");
        post({ type: "storage", present });
      } catch {
        post({ type: "storage-unavailable" });
      }
    })();
    """

    static func record(_ event: String) {
        var history = UserDefaults.standard.array(forKey: historyKey) as? [[String: Any]] ?? []
        history.append(["at": (Date().timeIntervalSince1970 * 1000).rounded(), "event": event])
        UserDefaults.standard.set(Array(history.suffix(limit)), forKey: historyKey)
    }

    func userContentController(_ userContentController: WKUserContentController,
                               didReceive message: WKScriptMessage,
                               replyHandler: @escaping (Any?, String?) -> Void) {
        let caller = message.frameInfo.securityOrigin
        guard message.frameInfo.isMainFrame,
              caller.protocol == origin.scheme, caller.host == origin.host,
              caller.port == origin.port,
              let body = message.body as? [String: Any],
              let type = body["type"] as? String else {
            replyHandler(nil, "Invalid native diagnostics request.")
            return
        }
        switch type {
        case "storage":
            let present = body["present"] as? Bool == true
            if !present && UserDefaults.standard.bool(forKey: Self.markerSeenKey) {
                Self.record("web-storage-empty")
            }
            UserDefaults.standard.set(true, forKey: Self.markerSeenKey)
            replyHandler(nil, nil)
        case "storage-unavailable":
            Self.record("web-storage-unavailable")
            replyHandler(nil, nil)
        case "read":
            replyHandler(UserDefaults.standard.array(forKey: Self.historyKey) ?? [], nil)
        default:
            replyHandler(nil, "Unsupported native diagnostics request.")
        }
    }
}
