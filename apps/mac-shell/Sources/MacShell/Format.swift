import Foundation

/// Display formatting shared by the transcript, the session list and the file tree.
///
/// Extracted from the bottom of `TranscriptView.swift`, where it was an awkward
/// dependency: two unrelated views imported the transcript's file to format a byte
/// count.
enum Format {
    /// Money, in the user's locale.
    ///
    /// Was `String(format: "$%.2f")`, which hardcodes a dollar sign and a full stop
    /// as the decimal separator regardless of where the user is. The gateway prices
    /// in USD, so the currency code is fixed — but the *formatting* of it is not
    /// ours to assume.
    static func usd(_ value: Double) -> String {
        // Sub-cent runs are the normal case, and "$0.00" reads as free — the one
        // thing a cost meter must never imply.
        if value > 0 && value < 0.01 {
            return "<" + (currency.string(from: 0.01) ?? "$0.01")
        }
        return currency.string(from: value as NSNumber) ?? String(format: "$%.2f", value)
    }

    /// Cost at the precision a single step actually costs.
    ///
    /// `usd(_:)` collapses anything under a cent to "<$0.01", which is right for a
    /// session total and useless for a step: a trace whose every row reads "<$0.01"
    /// says nothing about which step was expensive, and explaining a surprising bill
    /// is the entire reason the trace exists. Sub-cent amounts get the digits that
    /// distinguish them.
    static func microUsd(_ value: Double) -> String {
        if value <= 0 { return "—" }
        if value >= 0.01 { return usd(value) }
        return String(format: "$%.5f", value)
    }

    /// `1.2M`, `47K`. Rounds rather than truncating: integer division rendered
    /// 1,999,999 as "1M".
    static func compactTokens(_ count: Int) -> String {
        let value = Double(count)
        switch count {
        case 1_000_000...:
            return trimmed(value / 1_000_000) + "M"
        case 1_000...:
            return trimmed(value / 1_000) + "K"
        default:
            return "\(count)"
        }
    }

    /// `840ms`, `3.4s`. Milliseconds below a second, because a step that took 840ms
    /// reading as "0.8s" loses the only digit that distinguishes it from 100ms.
    static func duration(_ milliseconds: Double) -> String {
        milliseconds < 1_000
            ? "\(Int(milliseconds.rounded()))ms"
            : String(format: "%.1fs", milliseconds / 1_000)
    }

    static func bytes(_ count: Int) -> String {
        ByteCountFormatter.string(fromByteCount: Int64(count), countStyle: .file)
    }

    static func tokens(_ count: Int) -> String {
        decimal.string(from: count as NSNumber) ?? "\(count)"
    }

    private static func trimmed(_ value: Double) -> String {
        value < 10
            ? String(format: "%.1f", value).replacingOccurrences(of: ".0", with: "")
            : String(Int(value.rounded()))
    }

    private static let currency: NumberFormatter = {
        let formatter = NumberFormatter()
        formatter.numberStyle = .currency
        formatter.currencyCode = "USD"
        return formatter
    }()

    private static let decimal: NumberFormatter = {
        let formatter = NumberFormatter()
        formatter.numberStyle = .decimal
        return formatter
    }()
}
