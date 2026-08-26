import AppKit
import SwiftUI

/// The input field.
///
/// Return sends and Option-Return inserts a newline, which is the convention in every
/// chat client people already use. That is not what a plain `TextEditor` does, and
/// SwiftUI gives no way to intercept Return before the editor consumes it — so the
/// text view is an `NSTextView` and the key handling is explicit.
struct ComposerView: View {
    @EnvironmentObject private var conversation: ConversationStore
    @Binding var text: String
    var focusRequest: UInt64

    /// Measured from the text view's own layout, not guessed from a line count.
    /// Wrapping, font metrics and the container inset all move this, and a composer
    /// that is one line too short or too tall is immediately noticeable.
    @State private var measuredHeight: CGFloat = ComposerView.minHeight

    static let minHeight: CGFloat = 34
    static let maxHeight: CGFloat = 180

    var body: some View {
        VStack(spacing: 0) {
            if let message = conversation.errorMessage {
                ErrorBanner(message: message) { conversation.dismissError() }
            }

            HStack(alignment: .bottom, spacing: 8) {
                ZStack(alignment: .topLeading) {
                    if text.isEmpty {
                        Text(conversation.canSend ? "Ask for something…" : "Waiting for the workspace…")
                            .foregroundStyle(.tertiary)
                            .padding(.horizontal, 9)
                            .padding(.vertical, 8)
                            .allowsHitTesting(false)
                    }
                    SubmittingTextView(
                        text: $text,
                        focusRequest: focusRequest,
                        isEnabled: conversation.canSend,
                        measuredHeight: $measuredHeight,
                        onSubmit: submit
                    )
                    .frame(height: measuredHeight)
                }
                .background(Color(nsColor: .textBackgroundColor), in: RoundedRectangle(cornerRadius: 9, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: 9, style: .continuous)
                        .strokeBorder(Color(nsColor: .separatorColor))
                )

                if conversation.isStreaming {
                    Button(action: conversation.cancelTurn) {
                        Image(systemName: "stop.fill")
                            .frame(width: 22, height: 22)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(.secondary)
                    .help("Stop following this turn. The agent keeps working — there is no way to interrupt a tool call that has already started.")
                } else {
                    Button(action: submit) {
                        Image(systemName: "arrow.up")
                            .frame(width: 22, height: 22)
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(!conversation.canSend || text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    .help("Send (Return)")
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 11)
        }
        .background(.bar)
    }

    private func submit() {
        guard conversation.canSend else { return }
        let outgoing = text
        text = ""
        conversation.send(outgoing)
    }
}

private struct ErrorBanner: View {
    let message: String
    let dismiss: () -> Void

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(.orange)
            Text(message)
                .font(.callout)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 4)
            Button(action: dismiss) {
                Image(systemName: "xmark")
            }
            .buttonStyle(.borderless)
            .foregroundStyle(.secondary)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
        .background(Color.orange.opacity(0.12))
        .overlay(alignment: .bottom) { Divider() }
    }
}

/// An `NSTextView` that grows with its content and reports Return as a submit.
///
/// The height binding matters as much as the key handling: a fixed-height composer
/// hides the middle of a pasted paragraph, and a `TextEditor` that scrolls internally
/// at three lines is the single most common way a chat input feels cheap.
private struct SubmittingTextView: NSViewRepresentable {
    @Binding var text: String
    var focusRequest: UInt64
    var isEnabled: Bool
    @Binding var measuredHeight: CGFloat
    var onSubmit: () -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(self)
    }

    func makeNSView(context: Context) -> NSScrollView {
        let scrollView = NSTextView.scrollableTextView()
        guard let textView = scrollView.documentView as? NSTextView else { return scrollView }

        textView.delegate = context.coordinator
        textView.font = .preferredFont(forTextStyle: .body)
        textView.isRichText = false
        textView.allowsUndo = true
        textView.drawsBackground = false
        textView.textContainerInset = NSSize(width: 5, height: 7)
        // Smart quotes turn a straight quote into a curly one, which silently breaks
        // any command or code the user pastes or types into a message.
        textView.isAutomaticQuoteSubstitutionEnabled = false
        textView.isAutomaticDashSubstitutionEnabled = false
        textView.isAutomaticTextReplacementEnabled = false

        scrollView.drawsBackground = false
        scrollView.hasVerticalScroller = true
        scrollView.autohidesScrollers = true
        return scrollView
    }

    func updateNSView(_ scrollView: NSScrollView, context: Context) {
        guard let textView = scrollView.documentView as? NSTextView else { return }
        context.coordinator.parent = self

        if textView.string != text {
            textView.string = text
        }
        textView.isEditable = isEnabled
        textView.textColor = isEnabled ? .textColor : .disabledControlTextColor

        if context.coordinator.lastFocusRequest != focusRequest {
            context.coordinator.lastFocusRequest = focusRequest
            DispatchQueue.main.async {
                textView.window?.makeFirstResponder(textView)
            }
        }

        context.coordinator.remeasure(textView)
    }

    final class Coordinator: NSObject, NSTextViewDelegate {
        /// Refreshed on every `updateNSView` rather than captured once. The closure
        /// this holds is rebuilt each time the parent view struct is, and a stale copy
        /// would send with yesterday's text.
        var parent: SubmittingTextView
        var lastFocusRequest: UInt64 = 0

        init(_ parent: SubmittingTextView) {
            self.parent = parent
        }

        func textDidChange(_ notification: Notification) {
            guard let textView = notification.object as? NSTextView else { return }
            parent.text = textView.string
            remeasure(textView)
        }

        /// Asks TextKit what the text actually occupies.
        ///
        /// `ensureLayout` first, because `usedRect` reports whatever has been laid out
        /// so far — without it, the height lags a line behind on every keystroke.
        ///
        /// The clamp is not defensive tidiness. `usedRect` is called during the very
        /// first layout pass, before the text container has a real size, and what it
        /// returns then is not always a finite number. A non-finite height does not
        /// fail loudly: `min`/`max` propagate NaN straight through, SwiftUI hands the
        /// whole column a NaN proposal, and every sibling view — the transcript, both
        /// lists — silently lays out at nothing. The window comes up blank with no
        /// error anywhere.
        func remeasure(_ textView: NSTextView) {
            guard let container = textView.textContainer, let manager = textView.layoutManager else { return }
            manager.ensureLayout(for: container)

            let raw = manager.usedRect(for: container).height + textView.textContainerInset.height * 2
            let height = raw.isFinite
                ? Swift.min(Swift.max(raw, ComposerView.minHeight), ComposerView.maxHeight)
                : ComposerView.minHeight

            guard abs(height - parent.measuredHeight) > 0.5 else { return }
            // Deferred: this runs inside a SwiftUI update on the `updateNSView` path,
            // and writing to a binding there is the "Modifying state during view
            // update" warning.
            DispatchQueue.main.async { [parent] in parent.measuredHeight = height }
        }

        func textView(_ textView: NSTextView, doCommandBy selector: Selector) -> Bool {
            guard selector == #selector(NSResponder.insertNewline(_:)) else { return false }

            // Option-Return (and Shift-Return) insert a newline; a bare Return sends.
            let flags = NSApp.currentEvent?.modifierFlags ?? []
            if flags.contains(.option) || flags.contains(.shift) {
                textView.insertNewlineIgnoringFieldEditor(nil)
                return true
            }
            parent.onSubmit()
            return true
        }
    }
}
