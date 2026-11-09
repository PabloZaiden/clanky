#if os(iOS)
import Foundation

enum FrontendChannel: String, Sendable {
    case stable
    case latest

    static let preferenceKey = "useLatestFrontend"
    private static let appliedKey = "appliedFrontendChannel"

    static func selected(in defaults: UserDefaults = .standard) throws -> FrontendChannel {
        guard let setting = defaults.object(forKey: preferenceKey) else { return .stable }
        guard let latest = setting as? Bool else {
            throw NSError(domain: "Clanky", code: 6, userInfo: [
                NSLocalizedDescriptionKey: "The frontend channel preference is invalid."
            ])
        }
        return latest ? .latest : .stable
    }

    static func applied(in defaults: UserDefaults = .standard) throws -> FrontendChannel? {
        guard let setting = defaults.object(forKey: appliedKey) else { return nil }
        guard let name = setting as? String, let channel = FrontendChannel(rawValue: name) else {
            throw NSError(domain: "Clanky", code: 6, userInfo: [
                NSLocalizedDescriptionKey: "The saved frontend channel is invalid."
            ])
        }
        return channel
    }

    func recordApplied(in defaults: UserDefaults = .standard) {
        defaults.set(rawValue, forKey: Self.appliedKey)
    }

    var source: URL {
        URL(string: "https://pablozaiden.github.io/clanky/\(rawValue)/")!
    }

    func storageDirectory() throws -> URL {
        try FileManager.default.url(
            for: .applicationSupportDirectory, in: .userDomainMask,
            appropriateFor: nil, create: false
        ).appendingPathComponent("FrontendUpdates").appendingPathComponent(rawValue)
    }
}
#endif
