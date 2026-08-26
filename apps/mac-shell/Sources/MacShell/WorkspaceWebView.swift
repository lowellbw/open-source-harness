import AppKit
import OSLog
import SwiftUI
import WebKit

enum WebLoadState: Equatable {
    case loading
    case loaded
    case failed(String)
}

/// Hosts the web workspace. The window chrome, menus and lifecycle are native; the
/// document surface is the same web build the platform embed serves, so the two
/// shells never drift.
struct WorkspaceWebView: NSViewRepresentable {
    let url: URL
    let reloadNonce: UInt64
    @Binding var loadState: WebLoadState

    func makeCoordinator() -> Coordinator {
        Coordinator(loadState: $loadState)
    }

    func makeNSView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        // Persistent store: the workspace keeps its session in cookies/localStorage,
        // and a non-persistent store would sign the user out on every launch.
        configuration.websiteDataStore = .default()
        // Appends to the stock user agent rather than replacing it — a custom UA
        // string breaks the feature detection the web build does on its own.
        configuration.applicationNameForUserAgent = "AgenticWorkspaceMac/\(AppInfo.versionString)"

        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = context.coordinator
        webView.uiDelegate = context.coordinator
        // A shell window is not a browser: swipe-to-go-back and pinch zoom are
        // gestures the workspace UI wants for itself.
        webView.allowsBackForwardNavigationGestures = false
        webView.allowsMagnification = false
        // Painted behind the page so overscroll and the pre-first-paint window show
        // app chrome rather than white, which is what makes launch look native.
        webView.underPageBackgroundColor = .windowBackgroundColor
        #if DEBUG
        webView.isInspectable = true
        #endif

        // `sync` rather than `load`: it seeds the coordinator's nonce as well as its
        // URL, so a Reload issued before the view existed does not cause a second load
        // on the first update pass.
        context.coordinator.sync(url: url, reloadNonce: reloadNonce, in: webView)
        return webView
    }

    func updateNSView(_ webView: WKWebView, context: Context) {
        context.coordinator.sync(url: url, reloadNonce: reloadNonce, in: webView)
    }

    static func dismantleNSView(_ webView: WKWebView, coordinator: Coordinator) {
        coordinator.cancelPendingRetry()
        webView.navigationDelegate = nil
        webView.uiDelegate = nil
        webView.stopLoading()
    }

    /// Deliberately not `@MainActor`-isolated. WebKit's delegate callbacks arrive on
    /// the main thread anyway, and a non-isolated class satisfies the delegate
    /// protocols whether or not the SDK annotates them.
    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
        private static let maxAutomaticRetries = 3
        private static let maxContentProcessRecoveries = 2

        private let loadState: Binding<WebLoadState>
        private let log = Logger(subsystem: AppInfo.subsystem, category: "webview")

        private var lastLoadedURL: URL?
        private var lastReloadNonce: UInt64 = 0
        private var retryCount = 0
        private var contentProcessRecoveries = 0
        private var pendingRetry: DispatchWorkItem?

        init(loadState: Binding<WebLoadState>) {
            self.loadState = loadState
        }

        // MARK: - Loading

        /// Deliberately does not touch `loadState`. Both callers run inside a SwiftUI
        /// view update (`makeNSView` / `updateNSView`), and writing to a binding there
        /// is the "Modifying state during view update" warning. `didStartProvisionalNavigation`
        /// fires a moment later and sets `.loading` from outside the update.
        func load(_ url: URL, in webView: WKWebView) {
            cancelPendingRetry()
            retryCount = 0
            contentProcessRecoveries = 0
            lastLoadedURL = url
            webView.load(Self.request(for: url))
        }

        /// Called on every SwiftUI update, so it must be cheap and idempotent. Both
        /// triggers are value comparisons: a new sidecar port changes the URL, and the
        /// Reload command changes the nonce.
        func sync(url: URL, reloadNonce: UInt64, in webView: WKWebView) {
            if url != lastLoadedURL {
                lastReloadNonce = reloadNonce
                load(url, in: webView)
            } else if reloadNonce != lastReloadNonce {
                lastReloadNonce = reloadNonce
                load(url, in: webView)
            }
        }

        func cancelPendingRetry() {
            pendingRetry?.cancel()
            pendingRetry = nil
        }

        private static func request(for url: URL) -> URLRequest {
            var request = URLRequest(url: url)
            // The sidecar is restarted freely and may serve a different build on the
            // next port; a cached response would show the previous workspace.
            request.cachePolicy = .reloadIgnoringLocalCacheData
            request.timeoutInterval = 15
            return request
        }

        // MARK: - Navigation delegate

        func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
            loadState.wrappedValue = .loading
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            retryCount = 0
            contentProcessRecoveries = 0
            loadState.wrappedValue = .loaded
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            handleFailure(error, in: webView)
        }

        func webView(
            _ webView: WKWebView,
            didFailProvisionalNavigation navigation: WKNavigation!,
            withError error: Error
        ) {
            handleFailure(error, in: webView)
        }

        /// The web content process died — usually OOM. The view is blank and stays
        /// blank until something reloads it, which is the single most common cause of
        /// "the app shows nothing" reports.
        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            guard contentProcessRecoveries < Self.maxContentProcessRecoveries, let url = lastLoadedURL else {
                loadState.wrappedValue = .failed("The workspace view crashed repeatedly.")
                return
            }
            contentProcessRecoveries += 1
            log.error("Web content process terminated; reloading (recovery \(String(self.contentProcessRecoveries), privacy: .public))")
            loadState.wrappedValue = .loading
            webView.load(Self.request(for: url))
        }

        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction,
            decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
        ) {
            guard let url = navigationAction.request.url else {
                decisionHandler(.cancel)
                return
            }
            // `blob:` is allowed because a blob URL can only be minted by the page
            // already running in this frame, and the workspace uses them to open
            // generated files. `data:` is not: a top-level data: navigation is a
            // known way to render attacker-controlled markup inside trusted chrome.
            if url.absoluteString == "about:blank"
                || url.scheme?.lowercased() == "blob"
                || Self.isWorkspaceOrigin(url, expected: lastLoadedURL) {
                decisionHandler(.allow)
                return
            }

            decisionHandler(.cancel)

            // Everything that is not the local workspace leaves the shell. The window
            // reads as trusted app chrome, and the page inside it renders model output;
            // a top-level navigation to an attacker-chosen URL inside that frame is the
            // whole prompt-injection payoff. Handing it to the default browser keeps
            // the trust boundary where the user can see it.
            //
            // Only for a click, and only for the main frame: a page that can call
            // NSWorkspace.open from `location.href` can spray the default browser.
            let isMainFrame = navigationAction.targetFrame?.isMainFrame ?? true
            guard isMainFrame, navigationAction.navigationType == .linkActivated else { return }
            guard let scheme = url.scheme?.lowercased(), ["http", "https", "mailto"].contains(scheme) else { return }
            NSWorkspace.shared.open(url)
        }

        // MARK: - UI delegate

        /// `target="_blank"` and `window.open`. Returning nil means "no new web view";
        /// without this the link silently does nothing.
        func webView(
            _ webView: WKWebView,
            createWebViewWith configuration: WKWebViewConfiguration,
            for navigationAction: WKNavigationAction,
            windowFeatures: WKWindowFeatures
        ) -> WKWebView? {
            if let url = navigationAction.request.url,
               let scheme = url.scheme?.lowercased(),
               ["http", "https"].contains(scheme),
               !Self.isWorkspaceOrigin(url, expected: lastLoadedURL) {
                NSWorkspace.shared.open(url)
            }
            return nil
        }

        // MARK: - Failure handling

        private func handleFailure(_ error: Error, in webView: WKWebView) {
            let nsError = error as NSError

            // -999 is not a failure. It is what a load that was superseded by another
            // load reports, and treating it as one puts the retry panel over a page
            // that is loading correctly.
            if nsError.domain == NSURLErrorDomain && nsError.code == NSURLErrorCancelled {
                return
            }

            log.error("Workspace load failed: \(nsError.domain, privacy: .public) \(String(nsError.code), privacy: .public)")

            // The sidecar announces itself once `listen` calls back, but a first
            // connection can still lose a race against the listener under load. A few
            // quick retries cover that without the user seeing anything.
            if Self.isTransient(nsError), retryCount < Self.maxAutomaticRetries, let url = lastLoadedURL {
                retryCount += 1
                let delay = Double(retryCount) * 0.5
                loadState.wrappedValue = .loading
                let work = DispatchWorkItem { [weak webView] in
                    webView?.load(Coordinator.request(for: url))
                }
                pendingRetry = work
                DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work)
                return
            }

            loadState.wrappedValue = .failed(Self.describe(nsError))
        }

        private static func isTransient(_ error: NSError) -> Bool {
            guard error.domain == NSURLErrorDomain else { return false }
            return [
                NSURLErrorCannotConnectToHost,
                NSURLErrorNetworkConnectionLost,
                NSURLErrorTimedOut,
                NSURLErrorCannotFindHost,
            ].contains(error.code)
        }

        private static func describe(_ error: NSError) -> String {
            guard error.domain == NSURLErrorDomain else { return error.localizedDescription }
            switch error.code {
            case NSURLErrorCannotConnectToHost:
                return "The workspace server is not accepting connections on its port."
            case NSURLErrorTimedOut:
                return "The workspace server did not respond in time."
            case NSURLErrorNetworkConnectionLost:
                return "The connection to the workspace server was lost."
            default:
                return error.localizedDescription
            }
        }

        private static func isWorkspaceOrigin(_ url: URL, expected: URL?) -> Bool {
            guard let expected else { return false }
            guard url.scheme?.lowercased() == "http", expected.scheme?.lowercased() == "http" else { return false }
            guard url.host == expected.host else { return false }
            // Ports are compared explicitly: the sidecar picks a new one on every
            // restart, and "same host" alone would let any other local listener in.
            return url.port == expected.port
        }
    }
}
