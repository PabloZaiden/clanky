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
                BrowserSession(origin: origin, app: app)
            } else if let error = app.error {
                ContentUnavailableView {
                    Label("Unable to start Clanky", systemImage: "exclamationmark.triangle")
                } description: {
                    Text(error)
                } actions: {
                    Button("Retry") { Task { await app.start() } }
                }
            } else {
                #if os(iOS)
                if let offer = app.updateOffer {
                    ContentUnavailableView {
                        Label("Development frontend", systemImage: "hammer")
                    } description: {
                        Text("Replace \(offer.currentVersion) with \(offer.version) (\(offer.revision.prefix(7)))?")
                    } actions: {
                        Button("Update") { app.answerUpdate(true) }
                        Button("Keep Current") { app.answerUpdate(false) }
                    }
                } else {
                    ProgressView(app.startupMessage)
                }
                #else
                ProgressView("Opening Clanky…")
                #endif
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        #if os(iOS)
        .alert("Frontend Update", isPresented: Binding(
            get: { app.origin != nil && app.updateWarning != nil },
            set: { if !$0 { app.updateWarning = nil } }
        )) {
            Button("OK") { app.updateWarning = nil }
        } message: {
            Text(app.updateWarning ?? "")
        }
        #endif
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
    @EnvironmentObject private var app: AppModel
    @Environment(\.scenePhase) private var scenePhase
    @State private var sceneID = UUID()
    @StateObject private var browser: BrowserModel

    init(origin: URL, app: AppModel) {
        _browser = StateObject(wrappedValue: BrowserModel(origin: origin, ensureAssets: {
            try await app.ensureAssets()
        }))
    }

    var body: some View {
        browserContent
        .onAppear {
            app.setScenePhase(scenePhase, for: sceneID)
            browser.setScenePhase(scenePhase)
        }
        .onChange(of: scenePhase) { _, phase in
            app.setScenePhase(phase, for: sceneID)
            browser.setScenePhase(phase)
        }
        .onDisappear {
            app.setScenePhase(.inactive, for: sceneID)
            browser.setScenePhase(.inactive)
        }
        .sheet(item: $browser.popup) { popup in
            PopupContent(webView: popup.webView)
        }
        .alert("Clanky", isPresented: Binding(
            get: { browser.error != nil || app.error != nil },
            set: { if !$0 { browser.error = nil; app.error = nil } }
        )) {
            Button("Try Again") {
                app.allowAssetRetry()
                browser.reload()
            }
            Button("OK", role: .cancel) { browser.error = nil; app.error = nil }
        } message: {
            Text(browser.error ?? app.error ?? "")
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
            WebView(browser: browser)
                .ignoresSafeArea()
        }
        #else
        WebView(browser: browser)
        #endif
    }
}
