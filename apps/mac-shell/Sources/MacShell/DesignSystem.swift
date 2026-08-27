import AppKit
import SwiftUI

/// The design tokens, and the only place a colour, radius, space or type size is
/// allowed to be chosen.
///
/// Before this file existed the app used 19 distinct padding values, 13 stack
/// spacings, 6 corner radii in two different corner *styles*, 7 one-off opacities
/// and 5 hardcoded font point sizes — so two cards rendered 20pt apart had a 1pt
/// difference in their corners, and a code block nested inside a tool card was the
/// same grey at 10% different alpha. None of that was a decision; it was sixty-odd
/// independent guesses.
///
/// The eight core colours are ported verbatim from `apps/web/app/globals.css`.
/// PLAN-V2 §7 calls for a DTCG `tokens.json` compiled by Style Dictionary to *both*
/// CSS variables and SwiftUI constants, and `packages/tokens/` is planned for
/// exactly that — it does not exist yet, so these are hand-ported. Keep this file
/// shaped like something a generator would emit.
///
/// **SF Symbol rule**, since the app previously used both `exclamationmark.triangle`
/// and `.fill` for the same idea: *filled* variants describe a thing's status,
/// *outline* variants describe an action you can take.

// MARK: - Dynamic colour

/// A colour that resolves per-appearance at draw time.
///
/// `NSColor(name:dynamicProvider:)` rather than a `Color(light:dark:)` helper reading
/// `@Environment(\.colorScheme)`. Three reasons, all of which bite this app:
///
///  1. The composer is a real `NSTextView` and sets `textView.textColor` directly.
///     AppKit does not read SwiftUI's environment, so an environment-derived colour
///     is simply wrong there.
///  2. This resolves against `NSAppearance.currentDrawing()`, so it stays correct
///     inside a vibrant sidebar or a popover, where the window's `colorScheme` is
///     not the drawing appearance.
///  3. Increase Contrast is an *appearance*, not a boolean. The provider sees
///     `accessibilityHighContrastAqua` and can answer differently; a two-branch
///     helper cannot. `border` and `muted` genuinely need that.
enum DynamicColor {
    static func make(
        _ name: String,
        light: UInt32,
        dark: UInt32,
        lightContrast: UInt32? = nil,
        darkContrast: UInt32? = nil
    ) -> NSColor {
        NSColor(name: NSColor.Name(name)) { appearance in
            switch appearance.bestMatch(from: [
                .aqua, .darkAqua,
                .accessibilityHighContrastAqua, .accessibilityHighContrastDarkAqua,
            ]) {
            case .darkAqua:
                return NSColor(hex: dark)
            case .accessibilityHighContrastAqua:
                return NSColor(hex: lightContrast ?? light)
            case .accessibilityHighContrastDarkAqua:
                return NSColor(hex: darkContrast ?? dark)
            default:
                return NSColor(hex: light)
            }
        }
    }
}

extension NSColor {
    /// `0xRRGGBB`, in **sRGB**. The web tokens are sRGB hex; `calibratedRed:` or
    /// `deviceRGB` would shift them visibly in the blues.
    convenience init(hex: UInt32, alpha: CGFloat = 1) {
        self.init(
            srgbRed: CGFloat((hex >> 16) & 0xFF) / 255,
            green: CGFloat((hex >> 8) & 0xFF) / 255,
            blue: CGFloat(hex & 0xFF) / 255,
            alpha: alpha
        )
    }
}

/// One token, two representations: `.color` for SwiftUI, `.ns` for the AppKit seams.
struct ColorToken {
    let ns: NSColor

    /// `Color(nsColor:)` wraps rather than snapshots, so this stays appearance-correct.
    var color: Color { Color(nsColor: ns) }

    func opacity(_ value: Double) -> Color { color.opacity(value) }

    init(_ name: String, light: UInt32, dark: UInt32,
         lightContrast: UInt32? = nil, darkContrast: UInt32? = nil) {
        ns = DynamicColor.make(name, light: light, dark: dark,
                               lightContrast: lightContrast, darkContrast: darkContrast)
    }

    init(_ ns: NSColor) { self.ns = ns }
}

// MARK: - Palette

enum Palette {
    // The eight tokens shared with the web shell.
    static let bg = ColorToken("ds.bg", light: 0xFBFBFD, dark: 0x131316)
    static let surface = ColorToken("ds.surface", light: 0xFFFFFF, dark: 0x1C1C1F)
    static let border = ColorToken("ds.border", light: 0xE6E6EA, dark: 0x2C2C31,
                                   lightContrast: 0xB4B4BC, darkContrast: 0x55555E)
    static let text = ColorToken("ds.text", light: 0x1D1D1F, dark: 0xF5F5F7)
    static let muted = ColorToken("ds.muted", light: 0x6E6E73, dark: 0x98989D,
                                  lightContrast: 0x48484D, darkContrast: 0xC6C6CB)
    static let accent = ColorToken("ds.accent", light: 0x0071E3, dark: 0x2997FF)
    static let danger = ColorToken("ds.danger", light: 0xD70015, dark: 0xFF453A)
    static let ok = ColorToken("ds.ok", light: 0x248A3D, dark: 0x30D158)

    // Mac-only additions. The web has one canvas; this window has three panes that
    // have to read apart. Derived from `bg`, never invented, and deliberately few.

    /// The conversations source list.
    ///
    /// Opaque, not vibrant. A `.sidebar` list installs an `NSVisualEffectView` with
    /// behind-window blending, which samples the desktop — so on a warm wallpaper the
    /// pane came out visibly cream, and it changed colour as the window moved. A
    /// source list should be a stable surface, not a mood ring.
    static let sidebar = ColorToken("ds.sidebar", light: 0xF3F3F6, dark: 0x171719)

    /// The inspector, and any pane that is not the document.
    static let inspector = ColorToken("ds.inspector", light: 0xF3F3F6, dark: 0x171719)
    /// Behind inline code and payload dumps.
    static let codeFill = ColorToken("ds.codeFill", light: 0xEFEFF3, dark: 0x232328)
    /// Text on an accent fill. Fixed white in both appearances — `#0071e3` is dark
    /// enough in light mode and `#2997ff` saturated enough in dark that flipping is
    /// wrong.
    static let onAccent = ColorToken(.white)
}

/// The call-site API. `.foregroundStyle(.dsMuted)` reads like a system style, which
/// is the point: nothing in a view body should ever spell `Color(nsColor:)` again.
extension ShapeStyle where Self == Color {
    static var dsCanvas: Color { Palette.bg.color }
    static var dsSurface: Color { Palette.surface.color }
    static var dsInspector: Color { Palette.inspector.color }
    static var dsSidebar: Color { Palette.sidebar.color }
    static var dsBorder: Color { Palette.border.color }
    static var dsText: Color { Palette.text.color }
    static var dsMuted: Color { Palette.muted.color }
    static var dsAccent: Color { Palette.accent.color }
    static var dsDanger: Color { Palette.danger.color }
    static var dsOK: Color { Palette.ok.color }
    static var dsOnAccent: Color { Palette.onAccent.color }
    static var dsCodeFill: Color { Palette.codeFill.color }
}

// MARK: - Space

/// A 4pt grid. Seven values replacing nineteen paddings and thirteen spacings.
enum Space {
    static let hair: CGFloat = 2
    static let xs: CGFloat = 4
    static let s: CGFloat = 8
    static let m: CGFloat = 12
    static let l: CGFloat = 16
    static let xl: CGFloat = 24
    static let xxl: CGFloat = 32
}

/// Genuinely component-specific values that are off the grid. Named here rather than
/// typed inline so they are *enumerable* — an escape hatch you can count is a design
/// system; one you cannot is nineteen padding values.
enum Metric {
    /// Web parity: the user bubble is `px-3.5`.
    static let bubbleH: CGFloat = 14
    /// `NSTextView.textContainerInset` in the composer. The SwiftUI placeholder must
    /// use the same numbers or it sits off the caret — it currently uses 9/8 against
    /// the text view's 5/7, so the first character visibly jumps.
    static let composerInset = CGSize(width: 5, height: 7)
    static let statusDot: CGFloat = 6
    static let hairline: CGFloat = 1
    /// Sidebar document icons. 16, not 15: an odd size resamples a 16/32pt master
    /// and renders soft.
    static let rowIcon: CGFloat = 16
    /// The HIG's comfortable click target. Several controls were under half this.
    static let hitTarget: CGFloat = 28
    static let payloadMaxHeight: CGFloat = 260
}

// MARK: - Radius

/// Five named radii, ported from the web scale — and, the part that was actually
/// wrong, **one corner style**. The app mixed `.continuous` and the default
/// `.circular` at roughly half the call sites each, so the composer's corners and
/// the search field's corners beside it were visibly different curves.
enum Radius {
    static let inline: CGFloat = 4
    static let small: CGFloat = 6
    static let control: CGFloat = 8
    static let card: CGFloat = 12
    static let surface: CGFloat = 16

    static func shape(_ radius: CGFloat) -> RoundedRectangle {
        RoundedRectangle(cornerRadius: radius, style: .continuous)
    }
}

// MARK: - Layout

enum Layout {
    /// Web parity with `max-w-3xl`, so a paragraph wraps identically in both shells.
    static let contentMaxWidth: CGFloat = 768
    static let sidebarMin: CGFloat = 220
    static let sidebarIdeal: CGFloat = 288
    static let sidebarMax: CGFloat = 360
    static let inspectorMin: CGFloat = 240
    static let inspectorIdeal: CGFloat = 288
    static let inspectorMax: CGFloat = 420
    /// The user bubble caps at 85% of the column. Computed, not measured — no
    /// `GeometryReader` in a view that re-lays-out on every streaming delta.
    static let bubbleGutter: CGFloat = contentMaxWidth * 0.15
}

// MARK: - Type

/// Text styles only. No point sizes, anywhere.
///
/// macOS's text styles happen to land on exactly the web shell's scale — title 22,
/// title2 17, title3 15, body 13, callout 12, subheadline 11, caption 10 — so web
/// parity and Dynamic Type turn out to be the same change.
///
/// 10pt is the platform floor. The 8pt and 9pt sizes in the old code were below it,
/// did not scale at all, and are why the badges and eyebrows were unreadable. They
/// are deleted, not shrunk.
enum Typo {
    static let display = Font.system(.title, weight: .semibold)
    static let heading = Font.system(.title2, weight: .semibold)
    static let subhead = Font.system(.title3, weight: .semibold)
    static let bodyBold = Font.system(.body, weight: .semibold)
    static let body = Font.system(.body)
    static let secondary = Font.system(.callout)
    static let caption = Font.system(.subheadline)
    static let micro = Font.system(.caption)
    static let mono = Font.system(.callout, design: .monospaced, weight: .medium)
    static let monoSmall = Font.system(.caption, design: .monospaced)
    static let eyebrow = Font.system(.caption, weight: .semibold)
}

extension View {
    /// Headings: semibold plus the web's tracking-tight.
    func dsHeading(_ font: Font = Typo.heading) -> some View {
        self.font(font).tracking(-0.2).foregroundStyle(.dsText)
    }

    /// The uppercase micro-label above a payload block. Was three copies of the same
    /// five-modifier stack, all at 9pt `.tertiary` — about 2:1 against the window.
    func dsEyebrow() -> some View {
        self.font(Typo.eyebrow)
            .tracking(0.5)
            .textCase(.uppercase)
            .foregroundStyle(.dsMuted)
    }

    /// Body prose. The web's 1.625 line-height at 13pt is ~21pt; macOS defaults to
    /// ~16, hence the extra leading.
    func dsProse() -> some View {
        self.font(Typo.body).lineSpacing(Space.xs).foregroundStyle(.dsText)
    }
}

// MARK: - Motion

enum Motion {
    /// The only ambient animation in either shell: the status word breathing.
    /// Matches the web's `@keyframes pulse-soft` exactly — 1 → 0.45 → 1 over 1.4s.
    static let breathe = Animation.easeInOut(duration: 1.4).repeatForever(autoreverses: true)
    /// §7's "springy micro-interactions".
    static let disclose = Animation.spring(response: 0.26, dampingFraction: 0.86)
    static let scroll = Animation.easeOut(duration: 0.25)
}
