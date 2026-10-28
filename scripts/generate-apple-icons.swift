import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

struct IconCatalog: Decodable {
    struct Image: Decodable {
        let filename: String
        let idiom: String
        let size: String
        let scale: String?
    }
    let images: [Image]
}

let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
let catalog = root.appendingPathComponent("native/Shared/Assets.xcassets/AppIcon.appiconset")
let images = try JSONDecoder().decode(
    IconCatalog.self, from: Data(contentsOf: catalog.appendingPathComponent("Contents.json"))).images
guard let source = CGImageSourceCreateWithURL(root.appendingPathComponent("src/logo.png") as CFURL, nil),
      let logo = CGImageSourceCreateImageAtIndex(source, 0, nil),
      let colorSpace = CGColorSpace(name: CGColorSpace.sRGB) else {
    throw CocoaError(.fileReadCorruptFile)
}

for image in images {
    let dimensions = image.size.split(separator: "x")
    guard dimensions.count == 2, dimensions[0] == dimensions[1],
          let size = Int(dimensions[0]),
          let scale = Int((image.scale ?? "1x").dropLast()), size > 0, scale > 0 else {
        throw CocoaError(.fileReadCorruptFile)
    }
    let pixels = size * scale
    let mac = image.idiom == "mac"
    let alpha = mac ? CGImageAlphaInfo.premultipliedLast : .noneSkipLast
    guard let context = CGContext(
        data: nil, width: pixels, height: pixels, bitsPerComponent: 8, bytesPerRow: pixels * 4,
        space: colorSpace, bitmapInfo: CGBitmapInfo.byteOrder32Big.rawValue | alpha.rawValue) else {
        throw CocoaError(.fileWriteUnknown)
    }
    let bounds = CGRect(x: 0, y: 0, width: pixels, height: pixels)
    if !mac {
        context.setFillColor(CGColor(srgbRed: 43.0 / 255, green: 43.0 / 255, blue: 43.0 / 255, alpha: 1))
        context.fill(bounds)
    }
    context.interpolationQuality = .high
    // macOS icons include clear space; iOS applies its own mask to the opaque square.
    let inset = mac ? CGFloat(pixels) * 0.1 : 0
    context.draw(logo, in: bounds.insetBy(dx: inset, dy: inset))
    guard let result = context.makeImage(),
          let output = CGImageDestinationCreateWithURL(
            catalog.appendingPathComponent(image.filename) as CFURL, UTType.png.identifier as CFString, 1, nil) else {
        throw CocoaError(.fileWriteUnknown)
    }
    CGImageDestinationAddImage(output, result, nil)
    guard CGImageDestinationFinalize(output) else { throw CocoaError(.fileWriteUnknown) }
}
print("Generated Clanky Mac and iPhone/iPad app icons from src/logo.png.")
