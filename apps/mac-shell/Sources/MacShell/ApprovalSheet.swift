import SwiftUI

/// The approval prompt.
///
/// A sheet, not an alert: an alert cannot show a scrollable payload, and approving
/// something you cannot see is not consent. The payload is displayed in full rather
/// than summarised for the same reason.
///
/// **Deny is the default action** — it is focused, so Return denies and Escape denies.
/// That asymmetry is deliberate: an unanswered prompt already times out as a denial
/// server-side, and the muscle-memory Return should not be able to authorise something
/// irreversible.
///
/// **Allow is the filled, red one.** Weight and colour say "this is the consequential
/// button"; the default-button ring says "this is what happens if you do nothing".
/// Those are different questions, and the sheet should answer both. Previously both
/// buttons were plain bordered controls of equal weight, which answered neither.
struct ApprovalSheet: View {
    let approval: ApprovalRequest
    let resolve: (ApprovalDecision) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            Divider().overlay(.dsBorder)
            payload
            Divider().overlay(.dsBorder)
            actions
        }
        .frame(width: 520)
        // Bounded. `reason` is server-authored and unbounded, and with no cap a long
        // one grew the sheet past the bottom of the display, taking Allow and Deny
        // with it.
        .frame(maxHeight: 640)
        .background(.dsSurface)
        .accessibilityAddTraits(.isModal)
        .accessibilityLabel("Approval required")
    }

    private var header: some View {
        HStack(alignment: .top, spacing: Space.m) {
            Image(systemName: approval.irreversible
                  ? "exclamationmark.triangle.fill"
                  : "questionmark.circle")
                .font(Typo.heading)
                .foregroundStyle(approval.irreversible ? .dsDanger : .dsMuted)

            VStack(alignment: .leading, spacing: Space.xs) {
                Text("Approve this action?").dsHeading(Typo.subhead)
                Text(approval.reason)
                    .font(Typo.secondary)
                    .foregroundStyle(.dsMuted)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
            }
            Spacer(minLength: 0)
        }
        .padding(Space.l)
    }

    private var payload: some View {
        VStack(alignment: .leading, spacing: Space.xs) {
            SectionLabel("What will happen")
            ScrollView([.horizontal, .vertical]) {
                Text(approval.payload.prettyPrinted)
                    .font(Typo.monoSmall)
                    .foregroundStyle(.dsText)
                    .textSelection(.enabled)
                    .padding(Space.m)
            }
            .frame(maxHeight: 220)
            .well()
        }
        .padding(Space.l)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("What will happen")
    }

    private var actions: some View {
        HStack(spacing: Space.s) {
            if approval.irreversible {
                Label("This cannot be undone.", systemImage: "arrow.uturn.backward.circle.badge.xmark")
                    .font(Typo.caption)
                    .foregroundStyle(.dsDanger)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: Space.s)

            Button("Allow") { resolve(.allow) }
                .buttonStyle(.borderedProminent)
                .tint(.dsDanger)
                .controlSize(.large)

            Button("Deny") { resolve(.deny) }
                .buttonStyle(.bordered)
                .controlSize(.large)
                .keyboardShortcut(.defaultAction)
        }
        .padding(Space.l)
    }
}
