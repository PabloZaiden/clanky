#if os(iOS)
import SwiftUI
import WebKit

struct NativeToolbarItem: Decodable, Equatable, Identifiable {
    let id: String
    let label: String
    let systemImage: String?
    let imageURL: URL?
    let disabled: Bool
    let active: Bool
    let busy: Bool
    let destructive: Bool
}

struct NativeToolbarSnapshot: Decodable, Equatable {
    enum Theme: String, Decodable { case system, light, dark }
    let version: Int
    let scope: String
    let theme: Theme
    let sidebar: [NativeToolbarItem]
    let primary: [NativeToolbarItem]
    let menu: [NativeToolbarItem]
}

struct NativeToolbarLayout: Encodable, Equatable {
    struct Insets: Encodable, Equatable {
        let top, right, bottom, left: CGFloat
    }
    struct Rect: Encodable, Equatable {
        let x, y, width, height: CGFloat
    }
    let width, height: CGFloat
    let safeArea: Insets
    let occlusions: [Rect]
}

@MainActor
final class NativeToolbar: NSObject, ObservableObject, WKScriptMessageHandlerWithReply {
    @Published private(set) var snapshot: NativeToolbarSnapshot?
    @Published private(set) var supported = false
    @Published private(set) var images: [URL: UIImage] = [:]
    private var generation = 0
    private weak var webView: WKWebView?
    private var onError: ((String) -> Void)?
    private var layout: NativeToolbarLayout?
    private let origin: URL

    init(origin: URL) {
        self.origin = origin
        super.init()
    }

    func install(in controller: WKUserContentController) {
        controller.addScriptMessageHandler(self, contentWorld: .page, name: "webappToolbar")
        controller.addUserScript(WKUserScript(source: """
        (() => {
          let handler;
          const listeners = new Set();
          window.webappNativeToolbar = {
            update: snapshot => window.webkit.messageHandlers.webappToolbar.postMessage(snapshot),
            getLayout: () => window.webkit.messageHandlers.webappToolbar.postMessage('layout'),
            subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
            setActionHandler: value => {
              handler = value;
              return () => { if (handler === value) handler = undefined; };
            },
            activate: (scope, id) => {
              if (!handler) throw new Error('The web toolbar is not ready.');
              return handler(scope, id);
            },
            availabilityChanged: () => { for (const listener of listeners) listener(); }
          };
        })();
        """, injectionTime: .atDocumentStart, forMainFrameOnly: true))
    }

    func connect(to webView: WKWebView, onError: @escaping (String) -> Void) {
        self.webView = webView
        self.onError = onError
    }

    func clear() {
        generation += 1
        snapshot = nil
    }

    var canPresent: Bool {
        supported && snapshot.map { snapshot in
            (snapshot.sidebar + snapshot.primary + snapshot.menu).allSatisfy { item in
                item.imageURL.map { images[$0] != nil } ?? true
            }
        } == true
    }

    func setSupported(_ value: Bool) {
        guard supported != value else { return }
        supported = value
        notifyChange()
    }

    func setLayout(_ value: NativeToolbarLayout) {
        guard layout != value else { return }
        layout = value
        notifyChange()
    }

    private func notifyChange() {
        guard let webView, webView.url != nil, !webView.isLoading else { return }
        webView.callAsyncJavaScript(
            "window.webappNativeToolbar?.availabilityChanged()",
            arguments: [:], in: nil, in: .page
        ) { [weak self] result in
            if case .failure(let error) = result {
                self?.onError?("Unable to update the native presentation: \(error.localizedDescription)")
            }
        }
    }

    func userContentController(_ userContentController: WKUserContentController,
                               didReceive message: WKScriptMessage,
                               replyHandler: @escaping (Any?, String?) -> Void) {
        let securityOrigin = message.frameInfo.securityOrigin
        guard message.frameInfo.isMainFrame,
              securityOrigin.protocol == origin.scheme,
              securityOrigin.host == origin.host,
              securityOrigin.port == origin.port,
              let path = message.frameInfo.request.url?.path,
              path == "/api" || path.hasPrefix("/api/") ||
                path == "/collaboration" || path.hasPrefix("/collaboration/") else {
            replyHandler(nil, "Native toolbar messages require the bundled client.")
            return
        }
        if message.body as? String == "layout" {
            do {
                let value: Any
                if let layout {
                    value = try JSONSerialization.jsonObject(with: JSONEncoder().encode(layout))
                } else {
                    value = NSNull()
                }
                replyHandler(value, nil)
            } catch {
                replyHandler(nil, "Unable to provide the native layout: \(error.localizedDescription)")
            }
            return
        }
        if message.body is NSNull {
            clear()
            replyHandler(false, nil)
            return
        }
        guard JSONSerialization.isValidJSONObject(message.body) else {
            replyHandler(nil, "Invalid native toolbar description.")
            return
        }
        do {
            let data = try JSONSerialization.data(withJSONObject: message.body)
            let next = try JSONDecoder().decode(NativeToolbarSnapshot.self, from: data)
            let items = next.sidebar + next.primary + next.menu
            guard next.version == 1, !next.scope.isEmpty,
                  items.allSatisfy({ !$0.id.isEmpty && !$0.label.isEmpty }),
                  Set(items.map(\.id)).count == items.count else {
                replyHandler(nil, "Invalid native toolbar description.")
                return
            }
            let imageURLs = Set(items.compactMap(\.imageURL))
            guard imageURLs.allSatisfy({
                $0.scheme == origin.scheme && $0.host == origin.host &&
                    $0.port == origin.port && $0.user == nil && $0.password == nil
            }) else {
                replyHandler(nil, "Native toolbar images require bundled asset URLs.")
                return
            }
            generation += 1
            let publication = generation
            Task {
                do {
                    var loaded = images
                    if supported {
                        for url in imageURLs where loaded[url] == nil {
                            let (data, response) = try await URLSession.shared.data(for: URLRequest(url: url, timeoutInterval: 5))
                            guard (response as? HTTPURLResponse)?.statusCode == 200,
                                  let image = UIImage(data: data) else {
                                throw NSError(domain: "Clanky.NativeToolbar", code: 1, userInfo: [
                                    NSLocalizedDescriptionKey: "Unable to load the bundled toolbar image."
                                ])
                            }
                            loaded[url] = image
                        }
                    }
                    guard generation == publication else {
                        replyHandler(false, nil)
                        return
                    }
                    if loaded.count != images.count { images = loaded }
                    if snapshot != next { snapshot = next }
                    replyHandler(supported, nil)
                } catch {
                    if generation == publication { clear() }
                    replyHandler(nil, error.localizedDescription)
                }
            }
        } catch {
            replyHandler(nil, "Invalid native toolbar description: \(error.localizedDescription)")
        }
    }

    func activate(_ item: NativeToolbarItem, scope: String) {
        guard supported, let snapshot, snapshot.scope == scope,
              (snapshot.sidebar + snapshot.primary + snapshot.menu).contains(item),
              !item.disabled, !item.busy, let webView else {
            onError?("This toolbar action is no longer available.")
            return
        }
        webView.callAsyncJavaScript(
            "return window.webappNativeToolbar.activate(scope, id)",
            arguments: ["scope": scope, "id": item.id], in: nil, in: .page
        ) { [weak self] result in
            if case .failure(let error) = result {
                self?.onError?("Unable to run the toolbar action: \(error.localizedDescription)")
            }
        }
    }
}

@available(iOS 27.1, *)
struct NativeToolbarContent: View {
    @ObservedObject var browser: BrowserModel
    @ObservedObject var toolbar: NativeToolbar

    private var colorScheme: ColorScheme? {
        switch toolbar.snapshot?.theme {
        case .dark: .dark
        case .light: .light
        default: nil
        }
    }

    var body: some View {
        NavigationStack {
            WebView(browser: browser)
                .ignoresSafeArea()
                .toolbar {
                    if toolbar.canPresent, let snapshot = toolbar.snapshot {
                        ToolbarItemGroup(placement: .bottomBar) {
                            ForEach(snapshot.sidebar) { item in
                                toolbarButton(item, scope: snapshot.scope)
                            }
                            ForEach(snapshot.primary) { item in
                                toolbarButton(item, scope: snapshot.scope)
                            }
                            if !snapshot.menu.isEmpty {
                                Menu {
                                    ForEach(snapshot.menu) { item in
                                        Button(item.label, role: item.destructive ? .destructive : nil) {
                                            toolbar.activate(item, scope: snapshot.scope)
                                        }
                                        .disabled(item.disabled || item.busy)
                                    }
                                } label: {
                                    Image(systemName: "ellipsis")
                                }
                                .accessibilityLabel("Page actions")
                                .disabled(snapshot.menu.allSatisfy { $0.disabled || $0.busy })
                            }
                        }
                        .sharedBackgroundVisibility(.hidden)
                    }
                }
                .toolbarVisibility(.hidden, for: .navigationBar)
                .toolbarBackground(.hidden, for: .bottomBar)
        }
        .preferredColorScheme(colorScheme)
    }

    private func toolbarButton(_ item: NativeToolbarItem, scope: String) -> some View {
        Button(role: item.destructive ? .destructive : nil) {
            toolbar.activate(item, scope: scope)
        } label: {
            if item.busy {
                ProgressView()
            } else if let url = item.imageURL, let image = toolbar.images[url] {
                Image(uiImage: image)
                    .renderingMode(.original)
                    .resizable()
                    .scaledToFit()
                    .frame(width: 28, height: 28)
            } else if let symbol = item.systemImage {
                Label(item.label, systemImage: symbol).labelStyle(.iconOnly)
            } else {
                Text(item.label)
            }
        }
        .accessibilityLabel(item.label)
        .help(item.label)
        .disabled(item.disabled || item.busy)
        .tint(item.destructive ? .red : item.active ? .accentColor : .primary)
    }
}
#endif
