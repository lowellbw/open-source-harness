import SwiftUI

/// The approval prompt.
///
/// A sheet, not an alert: an alert cannot show a scrollable payload, and approving
/// something you cannot see is not consent. The payload is displayed in full rather
/// than summarised for the same reason.
///
/// Deny is the default action — it is the focused button, so Return denies and Escape
/// denies. That asymmetry is deliberate: an unanswered prompt already times out as a
/// denial server-side, and the muscle-memory Return should not be able to authorise
/// something irreversible.
///
/// §9: this is shown for irreversibility only. Prompting on everything trains people
/// to click through, which is worse than not prompting at all.
struct ApprovalSheet: View {
    let approval: ApprovalRequest
    let resolve: (ApprovalDecision) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .top, spacing: 11) {
                Image(systemName: approval.irreversible ? "exclamationmark.triangle.fill" : "questionmark.circle.fill")
                    .font(.title2)
                    .foregroundStyle(approval.irreversible ? .orange : .secondary)

                VStack(alignment: .leading, spacing: 3) {
                    Text("Approve this action?")
                        .font(.headline)
                    Text(approval.reason)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 0)
            }
            .padding(20)

            Divider()

            VStack(alignment: .leading, spacing: 5) {
                Text("WHAT WILL HAPPEN")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(.tertiary)
                    .tracking(0.5)
                ScrollView {
                    Text(approval.payload.prettyPrinted)
                        .font(.system(.caption, design: .monospaced))
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(9)
                }
                .frame(maxHeight: 200)
                .background(Color(nsColor: .textBackgroundColor), in: RoundedRectangle(cornerRadius: 7))
                .overlay(
                    RoundedRectangle(cornerRadius: 7)
                        .strokeBorder(Color(nsColor: .separatorColor))
                )
            }
            .padding(20)

            Divider()

            HStack {
                if approval.irreversible {
                    Label("This cannot be undone.", systemImage: "arrow.uturn.backward.circle.badge.xmark")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Button("Allow") { resolve(.allow) }
                Button("Deny") { resolve(.deny) }
                    .keyboardShortcut(.defaultAction)
            }
            .padding(20)
        }
        .frame(width: 520)
    }
}
