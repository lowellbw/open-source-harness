import SwiftUI

/// The web workspace, in its own window.
///
/// This is not the product surface — `RootView` is. It is kept because the Mac shell
/// and the platform embed are meant to render the same session, and the only way to
/// see a divergence is to put the two next to each other against one sidecar.
///
/// It is also what keeps `WorkspaceWebView`'s off-origin containment honest: a link in
/// model-rendered output must leave the window rather than navigate it, and that rule
/// needs a real `WKWebView` to be true of.
struct WebWorkspaceWindow: View {
    @EnvironmentObject private var services: AppServices
    @EnvironmentObject private var sidecar: SidecarController

    @State private var loadState: WebLoadState = .loading

    var body: some View {
        ZStack {
            Color.dsCanvas.ignoresSafeArea()

            if let endpoint = sidecar.state.endpoint {
                WorkspaceWebView(
                    url: endpoint.url,
                    reloadNonce: services.reloadNonce,
                    loadState: $loadState
                )
                .overlay(alignment: .topTrailing) {
                    if loadState == .loading {
                        ProgressView().controlSize(.small).padding(10)
                    }
                }
                .overlay {
                    if case .failed(let message) = loadState {
                        VStack(spacing: Space.m) {
                            Image(systemName: "exclamationmark.triangle.fill")
                                .font(Typo.heading)
                                .foregroundStyle(.dsDanger)
                            Text("The web workspace did not load")
                                .font(Typo.subhead)
                            Text(message)
                                .font(Typo.secondary)
                                .foregroundStyle(.dsMuted)
                                .multilineTextAlignment(.center)
                                .textSelection(.enabled)
                            Text(endpoint.url.absoluteString)
                                .lineLimit(1)
                                .truncationMode(.middle)
                                .font(Typo.monoSmall)
                                .foregroundStyle(.dsMuted)
                                .textSelection(.enabled)
                            Button("Reload") {
                                loadState = .loading
                                services.requestReload()
                            }
                            .keyboardShortcut(.defaultAction)
                        }
                        .padding(Space.xxl)
                        .frame(maxWidth: 460)
                        .card(radius: Radius.card)
                    }
                }
            } else {
                VStack(spacing: Space.m) {
                    ProgressView().controlSize(.small)
                    Text("Waiting for the workspace server")
                        .font(Typo.secondary)
                        .foregroundStyle(.dsMuted)
                }
            }
        }
        .navigationTitle("Web Workspace")
    }
}
