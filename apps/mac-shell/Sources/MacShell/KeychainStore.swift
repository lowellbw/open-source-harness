import Foundation
import Security

enum KeychainError: Error, LocalizedError, Equatable {
    case unexpectedStatus(OSStatus)
    case malformedData

    var errorDescription: String? {
        switch self {
        case .unexpectedStatus(let status):
            let message = SecCopyErrorMessageString(status, nil) as String? ?? "unknown error"
            return "Keychain error \(status): \(message)"
        case .malformedData:
            return "The stored item was not valid UTF-8 text."
        }
    }
}

/// Typed access to one service's generic-password items.
///
/// Scope is deliberately narrow: read, write, delete, exists, for string secrets
/// keyed by account. Provider API keys are the only thing the Mac shell stores
/// locally — everything else (budgets, model gating, quotas) is enforced at the
/// gateway, where the UI cannot be bypassed.
struct KeychainStore: Sendable {
    /// `kSecAttrService`. One namespace per app; accounts partition within it.
    let service: String

    /// Opt into the macOS data-protection ("modern", iOS-style) keychain.
    ///
    /// Off by default, and that default is load-bearing. The data-protection keychain
    /// requires the caller to be signed with a `keychain-access-groups` entitlement
    /// backed by a real team identifier; an ad-hoc-signed local build gets
    /// `errSecMissingEntitlement` (-34018) on the first `SecItemAdd` instead. Turn it
    /// on for Developer ID builds, where it also makes `kSecAttrAccessible` meaningful
    /// — the legacy file keychain ignores that attribute entirely.
    let useDataProtectionKeychain: Bool

    init(service: String, useDataProtectionKeychain: Bool = false) {
        self.service = service
        self.useDataProtectionKeychain = useDataProtectionKeychain
    }

    // MARK: - API

    /// Returns nil when there is no item, and throws only on real failures. A missing
    /// key is an ordinary state — the user has not entered one yet — so it must not
    /// be indistinguishable from a locked keychain or a denied ACL.
    func read(account: String) throws -> String? {
        var query = baseQuery(account: account)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne

        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)

        switch status {
        case errSecSuccess:
            guard let data = item as? Data else { throw KeychainError.malformedData }
            guard let secret = String(data: data, encoding: .utf8) else { throw KeychainError.malformedData }
            return secret
        case errSecItemNotFound:
            return nil
        default:
            throw KeychainError.unexpectedStatus(status)
        }
    }

    /// Presence check that never pulls the secret into the process.
    ///
    /// Worth having on its own: on the legacy keychain, reading the data can prompt
    /// the user for access when the calling binary's signature has changed, and the
    /// settings pane only needs to know whether a key is set.
    func contains(account: String) throws -> Bool {
        var query = baseQuery(account: account)
        query[kSecReturnData as String] = false
        query[kSecMatchLimit as String] = kSecMatchLimitOne

        let status = SecItemCopyMatching(query as CFDictionary, nil)
        switch status {
        case errSecSuccess: return true
        case errSecItemNotFound: return false
        default: throw KeychainError.unexpectedStatus(status)
        }
    }

    /// Create-or-replace.
    ///
    /// Add first, update on duplicate, rather than look-then-branch: the common case
    /// costs one call, and there is no window between the check and the write for a
    /// concurrent writer to slip into.
    func write(_ secret: String, account: String) throws {
        guard let data = secret.data(using: .utf8) else { throw KeychainError.malformedData }

        var attributes = baseQuery(account: account)
        attributes[kSecValueData as String] = data
        if useDataProtectionKeychain {
            // Available whenever the machine has been unlocked once since boot, and
            // never leaves this Mac. `WhenUnlocked` would break a sidecar started by a
            // launchd job at login before the user's keychain unlocks.
            attributes[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        }

        let addStatus = SecItemAdd(attributes as CFDictionary, nil)
        switch addStatus {
        case errSecSuccess:
            return
        case errSecDuplicateItem:
            // SecItemUpdate splits the dictionary in two: the query must not carry
            // kSecValueData, and the changes must carry nothing else.
            let query = baseQuery(account: account)
            let changes: [String: Any] = [kSecValueData as String: data]
            let updateStatus = SecItemUpdate(query as CFDictionary, changes as CFDictionary)
            guard updateStatus == errSecSuccess else {
                throw KeychainError.unexpectedStatus(updateStatus)
            }
        default:
            throw KeychainError.unexpectedStatus(addStatus)
        }
    }

    /// Idempotent: deleting an absent item succeeds. Callers are removing a key, not
    /// asserting that one was there.
    func delete(account: String) throws {
        let status = SecItemDelete(baseQuery(account: account) as CFDictionary)
        switch status {
        case errSecSuccess, errSecItemNotFound:
            return
        default:
            throw KeychainError.unexpectedStatus(status)
        }
    }

    // MARK: - Internals

    private func baseQuery(account: String) -> [String: Any] {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        if useDataProtectionKeychain {
            // Without this macOS routes the call to the legacy file keychain, where
            // kSecAttrAccessible is ignored and the item is ACL-bound to the signing
            // identity of whatever binary created it.
            query[kSecUseDataProtectionKeychain as String] = true
            // Provider credentials are org property and stay on the machine they were
            // entered on.
            query[kSecAttrSynchronizable as String] = false
        }
        return query
    }
}

/// Account names used by the shell. Constants rather than call-site literals so a
/// typo cannot silently create a second, invisible item.
enum KeychainAccount {
    static let providerAPIKey = "provider-api-key"
    /// Brave Search. Optional: without it search falls back to the provider-native
    /// tool, so this buys a different sub-processor rather than the feature.
    static let searchAPIKey = "search-api-key"
}
