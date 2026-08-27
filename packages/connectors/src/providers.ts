import type { ProviderConfig } from './oauth.js'

/**
 * Drive, Gmail and Slack.
 *
 * Scopes are the whole security story of a connector, so they are narrow and
 * each one is justified where it is not obvious. The temptation is to ask for
 * the broad scope once and never think about it again; the cost of that shows
 * up in a procurement questionnaire, where "why does this need to delete mail"
 * has no good answer.
 *
 * Nothing here has credentials baked in. A `clientId` is per-installation —
 * you register an app with Google and with Slack and supply them — and a
 * shipped client secret is not a secret.
 */

export const GOOGLE_AUTHORIZE = 'https://accounts.google.com/o/oauth2/v2/auth'
export const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token'

export function driveProvider(options: {
  clientId: string
  clientSecret?: string
  /** Grant write access. Off by default — reading is the common case. */
  allowWrite?: boolean
}): ProviderConfig {
  return {
    id: 'drive',
    displayName: 'Google Drive',
    authorizeUrl: GOOGLE_AUTHORIZE,
    tokenUrl: GOOGLE_TOKEN,
    clientId: options.clientId,
    ...(options.clientSecret ? { clientSecret: options.clientSecret } : {}),
    scopes: [
      // drive.readonly, not drive: the broad scope includes deleting, and
      // nothing here deletes.
      'https://www.googleapis.com/auth/drive.readonly',
      ...(options.allowWrite
        ? // drive.file is limited to files this app created or the user
          // explicitly opened with it — narrower than drive, and enough to
          // upload.
          ['https://www.googleapis.com/auth/drive.file']
        : []),
    ],
    authorizeParams: {
      // Without BOTH of these Google issues no refresh token, and the
      // connection silently stops working an hour later.
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
    },
  }
}

export function gmailProvider(options: {
  clientId: string
  clientSecret?: string
  /** Allow sending. Off by default; sending is irreversible. */
  allowSend?: boolean
}): ProviderConfig {
  return {
    id: 'gmail',
    displayName: 'Gmail',
    authorizeUrl: GOOGLE_AUTHORIZE,
    tokenUrl: GOOGLE_TOKEN,
    clientId: options.clientId,
    ...(options.clientSecret ? { clientSecret: options.clientSecret } : {}),
    scopes: [
      'https://www.googleapis.com/auth/gmail.readonly',
      ...(options.allowSend
        ? // gmail.send can only send. It cannot read, delete or modify, which
          // is why it is preferred over the modify scope for this.
          ['https://www.googleapis.com/auth/gmail.send']
        : []),
    ],
    authorizeParams: {
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
    },
  }
}

export function slackProvider(options: {
  clientId: string
  clientSecret?: string
  allowPost?: boolean
}): ProviderConfig {
  return {
    id: 'slack',
    displayName: 'Slack',
    authorizeUrl: 'https://slack.com/oauth/v2/authorize',
    tokenUrl: 'https://slack.com/api/oauth.v2.access',
    clientId: options.clientId,
    ...(options.clientSecret ? { clientSecret: options.clientSecret } : {}),
    scopes: [
      'channels:history',
      'channels:read',
      'search:read',
      'users:read',
      ...(options.allowPost ? ['chat:write'] : []),
    ],
    authorizeParams: {
      // Slack's user-token flow. `scope` alone requests a BOT token, which is
      // a different identity and cannot search the user's own messages.
      user_scope: [
        'channels:history',
        'channels:read',
        'search:read',
        ...(options.allowPost ? ['chat:write'] : []),
      ].join(','),
    },
  }
}

/**
 * Builds whichever providers this installation has credentials for.
 *
 * A connector with no client ID is absent rather than broken: a tool that
 * exists and always answers "not configured" is a tool the model will keep
 * trying.
 */
export function providersFromEnv(env: NodeJS.ProcessEnv = process.env): ProviderConfig[] {
  const providers: ProviderConfig[] = []

  const googleId = env.GOOGLE_CLIENT_ID
  if (googleId) {
    const common = {
      clientId: googleId,
      ...(env.GOOGLE_CLIENT_SECRET ? { clientSecret: env.GOOGLE_CLIENT_SECRET } : {}),
    }
    providers.push(driveProvider({ ...common, allowWrite: env.GOOGLE_ALLOW_WRITE === '1' }))
    providers.push(gmailProvider({ ...common, allowSend: env.GMAIL_ALLOW_SEND === '1' }))
  }

  const slackId = env.SLACK_CLIENT_ID
  if (slackId) {
    providers.push(
      slackProvider({
        clientId: slackId,
        ...(env.SLACK_CLIENT_SECRET ? { clientSecret: env.SLACK_CLIENT_SECRET } : {}),
        allowPost: env.SLACK_ALLOW_POST === '1',
      }),
    )
  }

  return providers
}
