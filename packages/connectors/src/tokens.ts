import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'

/**
 * Where OAuth tokens live.
 *
 * A refresh token is a standing grant to read someone's mail. It outlives the
 * session, survives a restart by design, and is worth more than the account
 * password because it does not expire and rarely prompts anyone.
 *
 * So it is encrypted at rest, with a key that is NOT stored beside it.
 * Encrypting with a key sitting in the next column is a ritual rather than a
 * protection; the key comes from the environment on Linux and from the Keychain
 * on a Mac, and if it is absent the store refuses to hold tokens rather than
 * pretending.
 *
 * AES-256-GCM: authenticated, so a token tampered with in the database fails to
 * decrypt instead of decrypting to something else.
 */

export interface StoredToken {
  provider: string
  accessToken: string
  refreshToken?: string
  /** Epoch millis. Absent means the provider did not say. */
  expiresAt?: number
  scopes: string[]
  /** Which account this is, for showing the user and for multi-account later. */
  account?: string
}

export interface TokenStore {
  put(token: StoredToken): void
  get(provider: string): StoredToken | undefined
  list(): StoredToken[]
  remove(provider: string): void
}

export class MissingEncryptionKey extends Error {
  constructor() {
    super(
      'No token encryption key. Set AGENTIC_TOKEN_KEY to a long random string, or supply one ' +
        'from the Keychain. Refusing to store OAuth refresh tokens in the clear.',
    )
    this.name = 'MissingEncryptionKey'
  }
}

/**
 * Derives the encryption key.
 *
 * scrypt rather than using the passphrase directly, so a short or low-entropy
 * value is expensive to attack rather than immediately equivalent to no
 * encryption. The salt is fixed and per-install rather than per-record, because
 * the goal is key derivation, not password hashing — a per-record salt would
 * mean storing it, and storing it beside the ciphertext gains nothing here.
 */
function deriveKey(passphrase: string): Buffer {
  return scryptSync(passphrase, 'agentic-workspace-tokens', 32)
}

export function encryptToken(plaintext: string, passphrase: string): string {
  const key = deriveKey(passphrase)
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  // iv.tag.ciphertext, each base64url so the whole thing is one safe string.
  return [iv, tag, encrypted].map((b) => b.toString('base64url')).join('.')
}

export function decryptToken(payload: string, passphrase: string): string {
  const [ivPart, tagPart, dataPart] = payload.split('.')
  if (!ivPart || !tagPart || !dataPart) {
    throw new Error('Malformed encrypted token.')
  }

  const decipher = createDecipheriv(
    'aes-256-gcm',
    deriveKey(passphrase),
    Buffer.from(ivPart, 'base64url'),
  )
  decipher.setAuthTag(Buffer.from(tagPart, 'base64url'))
  return Buffer.concat([
    decipher.update(Buffer.from(dataPart, 'base64url')),
    decipher.final(),
  ]).toString('utf8')
}

/**
 * The rows a token store keeps, encrypted.
 *
 * Separated from the storage mechanism so `packages/store` owns SQLite and this
 * package owns what a token is. The session layer wires one to the other.
 */
export interface EncryptedTokenRow {
  provider: string
  /** The whole StoredToken, encrypted as one blob. */
  payload: string
  /** Kept in the clear so a UI can list connections without the key. */
  account?: string
  scopes: string[]
  expiresAt?: number
}

export function sealToken(token: StoredToken, passphrase: string): EncryptedTokenRow {
  return {
    provider: token.provider,
    payload: encryptToken(JSON.stringify(token), passphrase),
    // Deliberately outside the ciphertext: showing "connected as x@y.com" must
    // not require the decryption key, or the connections list is unreadable on
    // a machine that has lost it — which is exactly when you want to see it.
    ...(token.account ? { account: token.account } : {}),
    scopes: token.scopes,
    ...(token.expiresAt ? { expiresAt: token.expiresAt } : {}),
  }
}

export function openToken(row: EncryptedTokenRow, passphrase: string): StoredToken {
  return JSON.parse(decryptToken(row.payload, passphrase)) as StoredToken
}

/**
 * An in-memory store, for tests and for a deployment that wants tokens to die
 * with the process.
 */
export class MemoryTokenStore implements TokenStore {
  private readonly rows = new Map<string, EncryptedTokenRow>()

  constructor(private readonly passphrase: string) {
    if (!passphrase) throw new MissingEncryptionKey()
  }

  put(token: StoredToken): void {
    this.rows.set(token.provider, sealToken(token, this.passphrase))
  }

  get(provider: string): StoredToken | undefined {
    const row = this.rows.get(provider)
    return row ? openToken(row, this.passphrase) : undefined
  }

  list(): StoredToken[] {
    return [...this.rows.values()].map((row) => openToken(row, this.passphrase))
  }

  remove(provider: string): void {
    this.rows.delete(provider)
  }
}

/** The key, from wherever this deployment keeps it. */
export function encryptionKeyFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.AGENTIC_TOKEN_KEY || undefined
}
