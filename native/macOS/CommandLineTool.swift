#if os(macOS)
import AppKit
import Foundation
import SwiftUI

struct CommandLineToolInstaller {
    struct ShellEnvironment {
        let directories: [URL]
        let zshDirectory: URL
    }

    let executable: URL
    let home: URL
    let shell: URL
    var directory: URL { home.appendingPathComponent(".local/bin") }
    var destination: URL { directory.appendingPathComponent("clanky") }

    func inspectShell() async throws -> ShellEnvironment {
        // Login/interactive startup files, not the GUI environment, own Terminal's PATH.
        let script = #"/usr/bin/printf '\000CLANKY_PATH\000'; /usr/bin/printenv PATH; /usr/bin/printf '\000'; /usr/bin/printenv ZDOTDIR; /usr/bin/printf '\000'"#
        let data = try await runNativeCommand(
            shell, arguments: ["-lic", script], environment: ProcessInfo.processInfo.environment)
        guard let marker = data.range(of: Data("\0CLANKY_PATH\0".utf8)) else {
            throw LocalControllerFailure(message: "Unable to read your shell's PATH.")
        }
        let fields = data[marker.upperBound...].split(separator: 0, maxSplits: 2, omittingEmptySubsequences: false)
        guard fields.count == 3,
              var path = String(data: Data(fields[0]), encoding: .utf8), path.hasSuffix("\n"),
              var zshDirectory = String(data: Data(fields[1]), encoding: .utf8) else {
            throw LocalControllerFailure(message: "Your shell returned an invalid PATH.")
        }
        path.removeLast()
        if zshDirectory.hasSuffix("\n") { zshDirectory.removeLast() }
        return ShellEnvironment(
            directories: path.split(separator: ":", omittingEmptySubsequences: false).map {
                $0.isEmpty ? home : URL(fileURLWithPath: String($0), relativeTo: home).standardizedFileURL
            },
            zshDirectory: zshDirectory.isEmpty ? home : URL(fileURLWithPath: zshDirectory, relativeTo: home)
        )
    }

    func existingCommand(in environment: ShellEnvironment) -> URL? {
        environment.directories.lazy.map { $0.appendingPathComponent("clanky") }.first {
            var isDirectory: ObjCBool = false
            return FileManager.default.fileExists(atPath: $0.path, isDirectory: &isDirectory)
                && !isDirectory.boolValue && FileManager.default.isExecutableFile(atPath: $0.path)
        }
    }

    func containsDirectory(in environment: ShellEnvironment) -> Bool {
        environment.directories.contains {
            $0.resolvingSymlinksInPath().path == directory.resolvingSymlinksInPath().path
        }
    }

    func startupFile(in environment: ShellEnvironment) throws -> URL? {
        guard !containsDirectory(in: environment) else { return nil }
        switch shell.lastPathComponent {
        case "zsh":
            return environment.zshDirectory.appendingPathComponent(".zshrc")
        case "bash":
            let candidates = [".bash_profile", ".bash_login", ".profile"].map { home.appendingPathComponent($0) }
            for candidate in candidates {
                if try attributes(at: candidate) != nil { return candidate }
            }
            return candidates[0]
        default:
            return nil
        }
    }

    func install(startupFile: URL?) throws {
        let files = FileManager.default
        guard files.isExecutableFile(atPath: executable.path) else {
            throw LocalControllerFailure(message: "The bundled Clanky CLI is missing. Reinstall the complete Mac app.")
        }
        let existing = try attributes(at: destination)
        if let existing {
            guard existing[.type] as? FileAttributeType == .typeSymbolicLink,
                  destination.resolvingSymlinksInPath() == executable.resolvingSymlinksInPath() else {
                throw LocalControllerFailure(message: "\(destination.path) already exists. Move it yourself before installing; it was not overwritten.")
            }
        }

        let addition = """
        # Clanky command line tool
        case ":$PATH:" in
            *:\(quote(directory.path)):*) ;;
            *) export PATH=\(quote(directory.path)):"$PATH" ;;
        esac

        """
        var current = ""
        if let startupFile {
            do { current = try String(contentsOf: startupFile, encoding: .utf8) }
            catch let error as CocoaError where error.code == .fileReadNoSuchFile {}
            guard !current.contains(addition) else {
                throw LocalControllerFailure(message: "Clanky's PATH setup is already in \(startupFile.path), but your shell overrides it. Update your PATH manually; no files were changed.")
            }
        }

        try files.createDirectory(at: directory, withIntermediateDirectories: true)
        if existing == nil { try files.createSymbolicLink(at: destination, withDestinationURL: executable) }
        if let startupFile {
            let data = Data(((current.isEmpty || current.hasSuffix("\n") ? "" : "\n") + "\n" + addition).utf8)
            do {
                if try attributes(at: startupFile) == nil {
                    try data.write(to: startupFile, options: .withoutOverwriting)
                } else {
                    let handle = try FileHandle(forWritingTo: startupFile)
                    do {
                        try handle.seekToEnd()
                        try handle.write(contentsOf: data)
                    } catch {
                        try? handle.close()
                        throw error
                    }
                    try handle.close()
                }
            } catch {
                throw LocalControllerFailure(message: "The CLI link is available at \(destination.path), but PATH setup in \(startupFile.path) failed: \(error.localizedDescription)")
            }
        }
    }

    private func attributes(at url: URL) throws -> [FileAttributeKey: Any]? {
        do { return try FileManager.default.attributesOfItem(atPath: url.path) }
        catch let error as CocoaError where error.code == .fileReadNoSuchFile { return nil }
    }

    private func quote(_ value: String) -> String {
        "'" + value.replacingOccurrences(of: "'", with: "'\\''") + "'"
    }
}

struct CommandLineToolCommands: Commands {
    @State private var busy = false

    var body: some Commands {
        CommandGroup(after: .appSettings) {
            Button("Install Command Line Tool...") { Task { await install() } }
                .disabled(busy)
        }
    }

    @MainActor private func install() async {
        guard !busy else { return }
        busy = true
        defer { busy = false }
        do {
            guard let account = getpwuid(getuid()), let shellPath = account.pointee.pw_shell,
                  shellPath.pointee != 0 else {
                throw LocalControllerFailure(message: "Unable to determine your login shell. No files were changed.")
            }
            let installer = CommandLineToolInstaller(
                executable: Bundle.main.bundleURL.appendingPathComponent("Contents/Helpers/clanky"),
                home: FileManager.default.homeDirectoryForCurrentUser,
                shell: URL(fileURLWithPath: String(cString: shellPath))
            )
            var environment = try await installer.inspectShell()
            if let existing = installer.existingCommand(in: environment) {
                show("Clanky is already in your PATH", "\(existing.path)\n\nYour existing CLI and PATH configuration were left unchanged.")
                return
            }
            let startup = try installer.startupFile(in: environment)
            let confirmation = NSAlert()
            confirmation.messageText = "Install the Clanky command line tool?"
            confirmation.informativeText = "Create \(installer.destination.path) as a link to this app's bundled CLI."
                + (startup.map { "\n\nAdd \(installer.directory.path) to PATH in \($0.path)." }
                    ?? (installer.containsDirectory(in: environment) ? "" : "\n\nYou will need to add \(installer.directory.path) to your shell's PATH manually."))
                + "\n\nNo administrator privileges are required. Keep this app in its current location; moving or removing it breaks the link. Update the CLI by updating the app."
            confirmation.addButton(withTitle: "Install")
            confirmation.addButton(withTitle: "Cancel")
            guard confirmation.runModal() == .alertFirstButtonReturn else { return }

            environment = try await installer.inspectShell()
            if let existing = installer.existingCommand(in: environment) {
                show("Clanky is already in your PATH", "\(existing.path)\n\nYour existing CLI and PATH configuration were left unchanged.")
                return
            }
            let startupFile = try installer.startupFile(in: environment)
            try installer.install(startupFile: startupFile)
            if startupFile == nil && !installer.containsDirectory(in: environment) {
                show("Clanky CLI link created", "\(installer.destination.path)\n\nAdd \(installer.directory.path) to your shell's PATH, then open a new Terminal session and run clanky version.")
            } else {
                let updated = try await installer.inspectShell()
                guard installer.existingCommand(in: updated)?.resolvingSymlinksInPath()
                        == installer.executable.resolvingSymlinksInPath() else {
                    throw LocalControllerFailure(message: "The link was created at \(installer.destination.path), but your shell still does not resolve it. Check your PATH configuration before trying again.")
                }
                show("Clanky command line tool installed", "\(installer.destination.path)\n\nOpen a new Terminal session and run clanky version.")
            }
        } catch {
            show("Unable to install the Clanky command line tool", error.localizedDescription)
        }
    }

    @MainActor private func show(_ title: String, _ message: String) {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = message
        alert.runModal()
    }
}
#endif
