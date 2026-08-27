#!/usr/bin/env swift
//
// Draws the app icon and writes an .iconset.
//
// There are no design assets anywhere in this repository and no network at build
// time, so the icon is drawn rather than checked in. Run via `tools/make-icon.sh`,
// which then calls `iconutil`; it is deliberately NOT part of build.sh's critical
// path, since regenerating art on every build buys nothing and adds a failure mode.
//
// The mark is the layered stack already used as the transcript's empty state, over
// the accent blue. Every size is rendered natively rather than downscaled from 1024,
// so the strokes land on whole pixels and the 16pt version stays crisp.

import AppKit
import SwiftUI // for a *continuous* corner curve; CGPath(roundedRect:) is circular,
               // and the difference is what reads as "not an Apple icon".

let outputDirectory = URL(fileURLWithPath: CommandLine.arguments[1])

let variants: [(String, Int)] = [
    ("icon_16x16", 16), ("icon_16x16@2x", 32),
    ("icon_32x32", 32), ("icon_32x32@2x", 64),
    ("icon_128x128", 128), ("icon_128x128@2x", 256),
    ("icon_256x256", 256), ("icon_256x256@2x", 512),
    ("icon_512x512", 512), ("icon_512x512@2x", 1024),
]

func colour(_ hex: UInt32) -> CGColor {
    CGColor(srgbRed: CGFloat((hex >> 16) & 0xFF) / 255,
            green: CGFloat((hex >> 8) & 0xFF) / 255,
            blue: CGFloat(hex & 0xFF) / 255,
            alpha: 1)
}

func render(_ pixels: Int) -> CGImage {
    let size = CGFloat(pixels)
    let context = CGContext(
        data: nil, width: pixels, height: pixels,
        bitsPerComponent: 8, bytesPerRow: 0,
        space: CGColorSpace(name: CGColorSpace.sRGB)!,
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    )!
    context.setAllowsAntialiasing(true)

    // Apple's macOS icon grid: an 824/1024 square with a 185.4/1024 continuous radius.
    let inset = size * 0.0977
    let plate = CGRect(x: inset, y: inset, width: size - inset * 2, height: size - inset * 2)
    let squircle = Path(roundedRect: plate, cornerRadius: size * 0.181, style: .continuous).cgPath

    context.saveGState()
    context.setShadow(offset: CGSize(width: 0, height: -size * 0.012),
                      blur: size * 0.03, color: CGColor(gray: 0, alpha: 0.28))
    context.addPath(squircle)
    context.setFillColor(CGColor(gray: 0, alpha: 1))
    context.fillPath()
    context.restoreGState()

    context.saveGState()
    context.addPath(squircle)
    context.clip()
    let gradient = CGGradient(
        colorsSpace: CGColorSpace(name: CGColorSpace.sRGB),
        colors: [colour(0x3D9BFF), colour(0x0057C8)] as CFArray,
        locations: [0, 1]
    )!
    context.drawLinearGradient(gradient,
                               start: CGPoint(x: 0, y: plate.maxY),
                               end: CGPoint(x: 0, y: plate.minY),
                               options: [])
    context.restoreGState()

    // Three stacked plates, drawn in the plate's unit space so every size matches.
    func point(_ x: CGFloat, _ y: CGFloat) -> CGPoint {
        CGPoint(x: plate.minX + x * plate.width, y: plate.minY + (1 - y) * plate.height)
    }

    func layer(at y: CGFloat, alpha: CGFloat) {
        let half = plate.width * 0.21
        let squash: CGFloat = 0.42
        context.beginPath()
        context.move(to: point(0.5, y - half / plate.height * squash))
        context.addLine(to: CGPoint(x: point(0.5, y).x + half, y: point(0.5, y).y))
        context.addLine(to: point(0.5, y + half / plate.height * squash))
        context.addLine(to: CGPoint(x: point(0.5, y).x - half, y: point(0.5, y).y))
        context.closePath()
        context.setFillColor(CGColor(gray: 1, alpha: alpha))
        context.fillPath()
    }

    layer(at: 0.66, alpha: 0.45)
    layer(at: 0.50, alpha: 0.72)
    layer(at: 0.34, alpha: 1.0)

    return context.makeImage()!
}

try? FileManager.default.createDirectory(at: outputDirectory, withIntermediateDirectories: true)
for (name, pixels) in variants {
    let representation = NSBitmapImageRep(cgImage: render(pixels))
    representation.size = NSSize(width: pixels, height: pixels)
    guard let data = representation.representation(using: .png, properties: [:]) else { continue }
    try data.write(to: outputDirectory.appendingPathComponent("\(name).png"))
}
FileHandle.standardError.write("wrote \(variants.count) icon sizes\n".data(using: .utf8)!)
