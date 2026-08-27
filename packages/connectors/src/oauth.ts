import { createHash, randomBytes } from 'node:crypto'
import type { StoredToken, TokenStore } from './tokens.js'

/**
 * OAuth, the authorization-code flow with PKCE.
 *
 * PKCE is not optional here even though this has a client secret available.
 * The redirect lands on a loopback listener, and on a shared machine any local
 * process can race to that port; the verifier is what makes an intercepted
 * code useless. Google and Slack both support it, and a flow that is correct
 * for a public client is also correct for a confidential one.
 *
 * `state` is checked, not merely sent. An unchecked state is a login-CSRF: an
 * attacker gets the user to complete a flow that connects the ATTACKER's
 * account, and everything the agent then reads and writes goes to them.
 */

export interface ProviderConfig {
  id: string
  displayName: string
  authorizeUrl: string
  tokenUrl: string
  clientId: string
  clientSecret?: string
  /** What is being asked for. Shown to the user before they are sent anywhere. */
  scopes: string[]
  /** Extra query parameters — Google needs these for a refresh token at all. */
  authorizeParams?: Record<string, string>
}

export interface PendingAuthorization {
  provider: string
  state: string
  verifier: string
  redirectUri: string
  createdAt: number
}

export class OAuthError extends Error {
  constructor(
    message: string,
    readonly provider: string,
  ) {
    super(`${provider}: ${message}`)
    this.name = 'OAuthError'
  }
}

/** How long a half-finished authorization stays valid. */
export const AUTHORIZATION_TTL_MS = 10 * 60 * 1000

export function base64url(buffer: Buffer): string {
  return buffer.toString('base64url')
}

export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(64))
  const challenge = base64url(createHash('sha256').update(verifier).digest())
  return { verifier, challenge }
}

/**
 * Starts a flow.
 *
 * Returns the URL to open and the pending record to hold onto. The pending
 * record is deliberately NOT stored inside this function: whoever calls it
 * decides where half-finished authorizations live, and in a multi-user
 * deployment that is per user rather than per process.
 */
export function beginAuthorization(
  config: ProviderConfig,
  redirectUri: string,
): { url: string; pending: PendingAuthorization } {
  const { verifier, challenge } = createPkcePair()
  const state = base64url(randomBytes(32))

  const url = new URL(config.authorizeUrl)
  url.searchParams.set('client_id', config.clientId)
  url.searchParams.set('redirect_uri', redirectUri)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('scope', config.scopes.join(' '))
  url.searchParams.set('state', state)
  url.searchParams.set('code_challenge', challenge)
  url.searchParams.set('code_challenge_method', 'S256')
  for (const [key, value] of Object.entries(config.authorizeParams ?? {})) {
    url.searchParams.set(key, value)
  }

  return {
    url: url.toString(),
    pending: { provider: config.id, state, verifier, redirectUri, createdAt: Date.now() },
  }
}

export interface TokenResponse {
  access_token: string
  refresh_token?: string
  expires_in?: number
  scope?: string
  token_type?: string
  /** Slack returns the authed user here; Google needs a separate call. */
  authed_user?: { id?: string }
  team?: { name?: string }
}

/**
 * Exchanges the code for tokens.
 *
 * `fetchImpl` is injected so the whole flow can be tested against a stub
 * provider rather than only against the real one — which is the difference
 * between knowing this works and hoping it does.
 */
export async function completeAuthorization(
  config: ProviderConfig,
  pending: PendingAuthorization,
  callback: { code: string; state: string },
  fetchImpl: typeof fetch = fetch,
): Promise<StoredToken> {
  if (Date.now() - pending.createdAt > AUTHORIZATION_TTL_MS) {
    throw new OAuthError('The sign-in took too long. Start again.', config.id)
  }

  // Constant-time is overkill for a value the attacker already supplied half
  // of, but the check itself is not optional: without it an attacker can have
  // the user complete a flow that connects the ATTACKER's account, and
  // everything the agent then reads and writes goes to them.
  if (callback.state !== pending.state) {
    throw new OAuthError('State did not match. The sign-in was not the one that was started.', config.id)
  }

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: callback.code,
    redirect_uri: pending.redirectUri,
    client_id: config.clientId,
    code_verifier: pending.verifier,
    ...(config.clientSecret ? { client_secret: config.clientSecret } : {}),
  })

  const response = await fetchImpl(config.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body,
  })

  const payload = (await response.json().catch(() => ({}))) as TokenResponse & {
    error?: string
    error_description?: string
    ok?: boolean
  }

  // Slack answers 200 with ok:false. Checking only the status code would
  // store an access token of `undefined` and fail later, somewhere else.
  if (!response.ok || payload.error || payload.ok === false || !payload.access_token) {
    throw new OAuthError(
      payload.error_description ?? payload.error ?? `Token exchange failed (${response.status})`,
      config.id,
    )
  }

  return toStoredToken(config, payload)
}

/**
 * Refreshes an expired access token.
 *
 * Returns undefined when there is no refresh token — which is a normal state,
 * not an error: Slack's modern tokens do not expire, and Google only issues a
 * refresh token when explicitly asked (`access_type=offline`, `prompt=consent`).
 */
export async function refreshAccessToken(
  config: ProviderConfig,
  token: StoredToken,
  fetchImpl: typeof fetch = fetch,
): Promise<StoredToken | undefined> {
  if (!token.refreshToken) return undefined

  const response = await fetchImpl(config.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: token.refreshToken,
      client_id: config.clientId,
      ...(config.clientSecret ? { client_secret: config.clientSecret } : {}),
    }),
  })

  const payload = (await response.json().catch(() => ({}))) as TokenResponse & { error?: string }
  if (!response.ok || payload.error || !payload.access_token) {
    throw new OAuthError(payload.error ?? `Refresh failed (${response.status})`, config.id)
  }

  return {
    ...toStoredToken(config, payload),
    // Most providers do not return a new refresh token on refresh. Dropping
    // the old one would disconnect the account on the next expiry.
    refreshToken: payload.refresh_token ?? token.refreshToken,
    ...(token.account ? { account: token.account } : {}),
  }
}

function toStoredToken(config: ProviderConfig, payload: TokenResponse): StoredToken {
  return {
    provider: config.id,
    accessToken: payload.access_token,
    ...(payload.refresh_token ? { refreshToken: payload.refresh_token } : {}),
    ...(payload.expires_in
      ? // Sixty seconds early. A token that expires between the check and the
        // request arriving fails in a way that looks like a permissions problem.
        { expiresAt: Date.now() + (payload.expires_in - 60) * 1_000 }
      : {}),
    scopes: payload.scope ? payload.scope.split(/[\s,]+/).filter(Boolean) : config.scopes,
    ...(payload.authed_user?.id ? { account: payload.authed_user.id } : {}),
  }
}

/**
 * A usable access token, refreshing first if it is about to expire.
 *
 * The single place anything asks for a token, so the refresh cannot be
 * forgotten at one call site out of twenty.
 */
export async function usableAccessToken(
  config: ProviderConfig,
  store: TokenStore,
  fetchImpl: typeof fetch = fetch,
): Promise<string | undefined> {
  const token = store.get(config.id)
  if (!token) return undefined

  if (token.expiresAt && token.expiresAt <= Date.now()) {
    const refreshed = await refreshAccessToken(config, token, fetchImpl)
    if (!refreshed) {
      // Expired with no way to refresh. Removed, so the UI says "not
      // connected" rather than showing a connection that fails on use.
      store.remove(config.id)
      return undefined
    }
    store.put(refreshed)
    return refreshed.accessToken
  }

  return token.accessToken
}
