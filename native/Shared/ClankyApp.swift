import SwiftUI

@main
struct ClankyApp: App {
    @StateObject private var model = AppModel()
    #if os(macOS)
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    #endif

    var body: some Scene {
        WindowGroup {
            BrowserWindow()
                .environmentObject(model)
                #if os(macOS)
                .environmentObject(model.controller)
                #endif
                .task {
                    #if os(macOS)
                    appDelegate.model = model
                    #endif
                    await model.start()
                }
        }
        #if os(macOS)
        .defaultSize(width: 1200, height: 800)
        .windowStyle(.hiddenTitleBar)
        .commands {
            ControllerCommands(controller: model.controller)
        }
        #endif
    }
}

struct BrowserWindow: View {
    @EnvironmentObject private var app: AppModel
    #if os(macOS)
    @EnvironmentObject private var controller: LocalController
    #endif

    var body: some View {
        Group {
            if let origin = app.origin {
                BrowserSession(origin: origin)
            } else if let error = app.error {
                ContentUnavailableView {
                    Label("Unable to start Clanky", systemImage: "exclamationmark.triangle")
                } description: {
                    Text(error)
                } actions: {
                    Button("Retry") { Task { await app.start() } }
                }
            } else {
                ProgressView("Opening Clanky…")
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        #if os(macOS)
        .alert("Local Controller", isPresented: Binding(
            get: { controller.error != nil },
            set: { if !$0 { controller.error = nil } }
        )) {
            Button("OK") { controller.error = nil }
        } message: {
            Text(controller.error ?? "")
        }
        #endif
    }
}

private struct BrowserSession: View {
    @StateObject private var browser: BrowserModel

    init(origin: URL) {
        _browser = StateObject(wrappedValue: BrowserModel(origin: origin))
    }

    var body: some View {
        browserContent
        .onAppear {
            if browser.webView.url == nil { browser.home() }
        }
        .sheet(item: $browser.popup) { popup in
            PopupContent(webView: popup.webView)
        }
        .alert("Clanky", isPresented: Binding(
            get: { browser.error != nil },
            set: { if !$0 { browser.error = nil } }
        )) {
            Button("Try Again", action: browser.reload)
            Button("OK", role: .cancel) { browser.error = nil }
        } message: {
            Text(browser.error ?? "")
        }
        #if os(macOS)
        .focusedSceneObject(browser)
        #endif
    }

    @ViewBuilder
    private var browserContent: some View {
        #if os(iOS)
        if #available(iOS 27.1, *) {
            NativeToolbarContent(browser: browser, toolbar: browser.nativeToolbar)
        } else {
            WebView(browser: browser).ignoresSafeArea()
        }
        #else
        WebView(browser: browser)
        #endif
    }
}
