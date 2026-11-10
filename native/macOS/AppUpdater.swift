import Combine
import Sparkle
import SwiftUI

enum AppUpdateChannel: String, CaseIterable {
    case stable
    case latest

    var title: String { rawValue.capitalized }
    var interval: TimeInterval { self == .latest ? 3600 : 86400 }
}

@MainActor
final class AppUpdater: NSObject, ObservableObject, SPUUpdaterDelegate {
    @Published private(set) var channel: AppUpdateChannel
    @Published private(set) var canCheck = false
    @Published private(set) var busy = false
    @Published private(set) var automaticChecks = true
    @Published private(set) var automaticDownloads = true
    @Published private(set) var installationPending = false
    @Published private(set) var error: String?
    let enabled: Bool
    let installedVersion: String
    let installedChannel: String
    let installedBuild: String
    let installedRevision: String
    private var installHandler: (() -> Void)?
    var canInstall: Bool { installationPending && installHandler != nil }
    private lazy var driver = SPUStandardUpdaterController(
        startingUpdater: false, updaterDelegate: self, userDriverDelegate: nil
    )

    override init() {
        let info = Bundle.main.infoDictionary ?? [:]
        installedChannel = info["ClankyDistributionChannel"] as? String ?? "development"
        installedVersion = info["ClankyDistributionVersion"] as? String ?? "development"
        installedBuild = info["CFBundleVersion"] as? String ?? "development"
        installedRevision = info["ClankySourceRevision"] as? String ?? "development"
        enabled = AppUpdateChannel(rawValue: installedChannel) != nil
        channel = UserDefaults.standard.string(forKey: "appUpdateChannel").flatMap(AppUpdateChannel.init)
            ?? AppUpdateChannel(rawValue: installedChannel) ?? .stable
        super.init()
        guard enabled else { return }
        let updater = driver.updater
        updater.publisher(for: \.canCheckForUpdates).assign(to: &$canCheck)
        updater.publisher(for: \.sessionInProgress).assign(to: &$busy)
        updater.publisher(for: \.automaticallyChecksForUpdates).assign(to: &$automaticChecks)
        updater.publisher(for: \.automaticallyDownloadsUpdates).assign(to: &$automaticDownloads)
        do {
            try updater.start()
        } catch {
            NSLog("Clanky updater could not start: %@", error.localizedDescription)
            self.error = error.localizedDescription
        }
    }

    func check() { driver.checkForUpdates(nil) }
    func installAndRestart() {
        guard canInstall else { return }
        installHandler?()
    }

    func select(_ channel: AppUpdateChannel) {
        guard enabled, canCheck, !busy, !installationPending, channel != self.channel else { return }
        self.channel = channel
        UserDefaults.standard.set(channel.rawValue, forKey: "appUpdateChannel")
        driver.updater.updateCheckInterval = channel.interval
        driver.updater.resetUpdateCycle()
    }

    func setAutomaticChecks(_ enabled: Bool) { driver.updater.automaticallyChecksForUpdates = enabled }
    func setAutomaticDownloads(_ enabled: Bool) { driver.updater.automaticallyDownloadsUpdates = enabled }

    func feedURLString(for updater: SPUUpdater) -> String? {
        guard let installed = Bundle.main.object(forInfoDictionaryKey: "SUFeedURL") as? String,
              let url = URL(string: installed) else { return nil }
        return url.deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent(channel.rawValue).appendingPathComponent("appcast.xml").absoluteString
    }

    func allowedChannels(for updater: SPUUpdater) -> Set<String> { [channel.rawValue] }

    func updater(_ updater: SPUUpdater, didFindValidUpdate item: SUAppcastItem) {
        error = nil
    }

    func updater(_ updater: SPUUpdater, willInstallUpdateOnQuit item: SUAppcastItem,
                 immediateInstallationBlock immediateInstallHandler: @escaping () -> Void) -> Bool {
        installHandler = immediateInstallHandler
        installationPending = true
        return true
    }

    func updater(_ updater: SPUUpdater, willInstallUpdate item: SUAppcastItem) {
        installationPending = true
    }

    func updater(_ updater: SPUUpdater, didAbortWithError error: Error) {
        installHandler = nil
        installationPending = false
        let failure = error as NSError
        if failure.domain == SUSparkleErrorDomain && failure.code == SUError.noUpdateError.rawValue {
            self.error = nil
            return
        }
        NSLog("Clanky update failed: %@", error.localizedDescription)
        self.error = error.localizedDescription
    }
}

struct AppUpdateCommands: Commands {
    @ObservedObject var updater: AppUpdater

    var body: some Commands {
        CommandGroup(after: .appInfo) {
            Button("Check for Updates...") { updater.check() }
                .disabled(!updater.enabled || !updater.canCheck)
            Button("Install and Restart") { updater.installAndRestart() }
                .disabled(!updater.canInstall)
        }
    }
}

struct AppUpdateSettings: View {
    @ObservedObject var updater: AppUpdater

    var body: some View {
        Form {
            LabeledContent("Installed", value: "\(updater.installedVersion) (\(updater.installedChannel))")
            LabeledContent("Build", value: updater.installedBuild)
            LabeledContent("Revision", value: String(updater.installedRevision.prefix(7)))
            Picker("Update channel", selection: Binding(
                get: { updater.channel }, set: { updater.select($0) }
            )) {
                ForEach(AppUpdateChannel.allCases, id: \.self) { Text($0.title).tag($0) }
            }
            .disabled(!updater.enabled || updater.busy || updater.installationPending || !updater.canCheck)
            if updater.installationPending { Text("Quit Clanky to finish installing the downloaded update before changing channels.") }
            Toggle("Automatically check for updates", isOn: Binding(
                get: { updater.automaticChecks }, set: { updater.setAutomaticChecks($0) }
            ))
            .disabled(!updater.enabled)
            Toggle("Download updates and install when Clanky quits", isOn: Binding(
                get: { updater.automaticDownloads }, set: { updater.setAutomaticDownloads($0) }
            ))
            .disabled(!updater.enabled || !updater.automaticChecks)
            Button("Check for Updates...") { updater.check() }
                .disabled(!updater.enabled || !updater.canCheck)
            if updater.installationPending {
                Button("Install and Restart") { updater.installAndRestart() }
                    .disabled(!updater.canInstall)
            }
            if !updater.enabled { Text("Automatic updates are unavailable in development builds.") }
            if let error = updater.error { Text(error).foregroundStyle(.red).textSelection(.enabled) }
        }
        .padding()
        .frame(width: 520)
    }
}
