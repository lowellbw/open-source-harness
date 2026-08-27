import AppKit
import SwiftUI

/// Surfaces, translucency, and the only macOS 26 APIs in the app.
///
/// Kept apart from `DesignSystem.swift` deliberately: that file is values a
/// generator could emit, this one is branching logic, and it is the riskiest small
/// piece of the redesign — it should be reviewable on its own.
///
/// **Two gates are needed and neither is sufficient alone.** `#available(macOS 26,*)`
/// is a *runtime* check; it still requires the SDK to declare the symbol, so building
/// this package with Xcode 16 would fail to compile `.glassEffect` no matter how it
/// is gated at runtime. `#if compiler(>=6.2)` is the SDK gate — Xcode 26 ships Swift
/// 6.2 — and `#available` is the OS gate.
///
/// **The rule this file exists to enforce: geometry lives outside the branch.**
/// Padding, frame, radius and stroke inset are chosen by the caller from tokens; only
/// the *fill* is chosen inside the branch. Both arms must produce identical layout,
/// which makes a glass/legacy screenshot pair its own regression test — same bounding
/// boxes, different pixels.

enum Theme {
    /// Whether to use real Liquid Glass.
    ///
    /// The environment override is not a debug nicety, it is the only way the
    /// fallback ever gets looked at. `#available(macOS 26, *)` is always true on the
    /// machine this was built on, so without a kill switch the macOS 14/15 path is
    /// dead code that would ship having never once been rendered.
    /// `AGENTIC_LEGACY_CHROME=1` forces it, so every screenshot can be taken twice.
    static let usesGlass: Bool = {
        guard #available(macOS 26, *) else { return false }
        return ProcessInfo.processInfo.environment["AGENTIC_LEGACY_CHROME"] != "1"
    }()

    /// Per-app appearance override, so dark mode can be captured without touching
    /// the user's system setting. `AGENTIC_APPEARANCE=dark|light`.
    static var appearanceOverride: NSAppearance? {
        switch ProcessInfo.processInfo.environment["AGENTIC_APPEARANCE"] {
        case "dark": return NSAppearance(named: .darkAqua)
        case "light": return NSAppearance(named: .aqua)
        default: return nil
        }
    }
}

// MARK: - Chrome

/// Translucency, in the one place it is allowed.
///
/// PLAN-V2 §7: "translucency used *sparingly* — on floating chrome…, **never on
/// content surfaces**." So this is for the toolbar, the composer bar and small
/// floating elements — things with app content behind them to refract. The transcript
/// canvas, the inspector, tool cards, code blocks and the approval payload are all
/// opaque tokens instead.
///
/// `accessibilityReduceTransparency` short-circuits before any blur is requested,
/// which §7 also requires.
struct ChromeSurface<S: Shape>: ViewModifier {
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    let shape: S

    func body(content: Content) -> some View {
        if reduceTransparency {
            content.background(.dsSurface, in: shape)
        } else {
            #if compiler(>=6.2)
            if #available(macOS 26, *), Theme.usesGlass {
                content.glassEffect(.regular, in: shape)
            } else {
                content.background(.bar, in: shape)
            }
            #else
            content.background(.bar, in: shape)
            #endif
        }
    }
}

extension View {
    /// Floating chrome only. Never call this on a content surface or a pane.
    func chromeSurface<S: Shape>(_ shape: S = Rectangle()) -> some View {
        modifier(ChromeSurface(shape: shape))
    }

    /// Groups sibling glass elements so the blur is computed once rather than
    /// stacked. §7: cap stacked blur layers.
    @ViewBuilder
    func glassGroup() -> some View {
        #if compiler(>=6.2)
        if #available(macOS 26, *), Theme.usesGlass {
            GlassEffectContainer { self }
        } else {
            self
        }
        #else
        self
        #endif
    }

    /// Content dissolving under the toolbar rather than meeting a hard line.
    @ViewBuilder
    func dsScrollEdge() -> some View {
        #if compiler(>=6.2)
        if #available(macOS 26, *), Theme.usesGlass {
            self.scrollEdgeEffectStyle(.soft, for: .all)
        } else {
            self
        }
        #else
        self
        #endif
    }

    /// An opaque card: one fill, one hairline, one radius, one corner style.
    func card(radius: CGFloat = Radius.card, stroke: Color = .dsBorder) -> some View {
        background(.dsSurface, in: Radius.shape(radius))
            .overlay(Radius.shape(radius).strokeBorder(stroke, lineWidth: Metric.hairline))
    }

    /// A recessed well for a payload dump or code block.
    func well(radius: CGFloat = Radius.card) -> some View {
        background(.dsCodeFill, in: Radius.shape(radius))
            .overlay(Radius.shape(radius).strokeBorder(.dsBorder, lineWidth: Metric.hairline))
    }

    /// Guarantees a control is at least the HIG's comfortable click target.
    func hitTarget(_ size: CGFloat = Metric.hitTarget) -> some View {
        frame(minWidth: size, minHeight: size)
            .contentShape(Rectangle())
    }
}

// MARK: - Motion

/// The one ambient animation in the app.
///
/// Replaces two: the three sine-driven dots of `TypingIndicator`, which **never
/// animated** — `.opacity()` interpolates between resolved endpoints and does not
/// re-evaluate `sin()` per frame, and with `autoreverses: false` and equal endpoints
/// the whole thing was a no-op — and the spinners that duplicated it.
private struct Breathing: ViewModifier {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let active: Bool
    @State private var dim = false

    func body(content: Content) -> some View {
        content
            .opacity(reduceMotion || !active ? 1 : (dim ? 0.45 : 1))
            .animation(reduceMotion || !active ? nil : Motion.breathe, value: dim)
            .onAppear { dim = active }
            .onChange(of: active) { _, isActive in dim = isActive }
    }
}

extension View {
    func breathing(_ active: Bool = true) -> some View {
        modifier(Breathing(active: active))
    }
}

// MARK: - Layout probe

/// Asserts a view was given a sane size, and logs it when asked.
///
/// Every layout failure in this app has been silent and total: a split view that
/// returned 1267pt when proposed 808pt and drew its children off the window, and a
/// non-finite text height that propagated through `min`/`max` and blanked everything.
/// Neither logged a thing, and both cost hours of bisection.
///
/// This is the cheap instrument that would have caught both in seconds.
/// `AGENTIC_LAYOUT_PROBE=1` turns on logging; the non-finite assertion is always on
/// in debug builds.
struct LayoutProbe: ViewModifier {
    let label: String

    private static let logging = ProcessInfo.processInfo.environment["AGENTIC_LAYOUT_PROBE"] == "1"

    func body(content: Content) -> some View {
        content.background(
            GeometryReader { proxy in
                Color.clear
                    .onAppear { Self.check(label, proxy.size) }
                    .onChange(of: proxy.size) { _, size in Self.check(label, size) }
            }
        )
    }

    private static func check(_ label: String, _ size: CGSize) {
        let sane = size.width.isFinite && size.height.isFinite
        if logging || !sane {
            NSLog("LAYOUT %@ %.1f x %.1f%@", label, size.width, size.height,
                  sane ? "" : "  ← NOT FINITE")
        }
        assert(sane, "\(label) got a non-finite size — this blanks the window silently")
    }
}

extension View {
    func layoutProbe(_ label: String) -> some View {
        modifier(LayoutProbe(label: label))
    }
}

// MARK: - Shared components

/// One banner, used for the error strip above the composer and the archived notice
/// above the transcript.
///
/// Those were two separate private views differing by one point of vertical padding
/// and one point of stack spacing — the clearest example in the app of what happens
/// without a shared component. Under a restyle they would have diverged further.
struct InlineBanner: View {
    enum Tone {
        case error, info

        var symbol: String {
            switch self {
            case .error: return "exclamationmark.triangle.fill"
            case .info: return "clock.arrow.circlepath"
            }
        }
    }

    let tone: Tone
    let message: String
    var dismiss: (() -> Void)?

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: Space.s) {
            Image(systemName: tone.symbol)
                .foregroundStyle(tone == .error ? .dsDanger : .dsMuted)
            Text(message)
                .font(Typo.caption)
                .foregroundStyle(tone == .error ? .dsText : .dsMuted)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: Space.xs)
            if let dismiss {
                Button(action: dismiss) {
                    Label("Dismiss", systemImage: "xmark")
                        .labelStyle(.iconOnly)
                        .hitTarget(22)
                }
                .buttonStyle(.plain)
                .foregroundStyle(.dsMuted)
            }
        }
        .padding(.horizontal, Space.l)
        .padding(.vertical, Space.s)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(tone == .error ? Palette.danger.opacity(0.10) : .dsInspector)
        .overlay(alignment: .bottom) {
            Rectangle().fill(.dsBorder).frame(height: Metric.hairline)
        }
    }
}

/// A status dot. Colour *and* an accessibility label, because colour alone fails for
/// the ~8% of men who are colour-blind — and the connector dot previously carried its
/// entire meaning in six points of green or grey.
struct StatusDot: View {
    let color: Color
    let label: String

    var body: some View {
        Circle()
            .fill(color)
            .frame(width: Metric.statusDot, height: Metric.statusDot)
            .accessibilityLabel(label)
    }
}
