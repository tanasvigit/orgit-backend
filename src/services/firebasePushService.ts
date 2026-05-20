import { query } from '../config/database';

/**
 * FCM push via Firebase Admin (see services/firebaseAdmin.js).
 * No-op when credentials are not configured.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const firebaseAdmin = require('../../services/firebaseAdmin') as {
  sendPushToTokens?: (
    tokens: string[],
    title: string,
    body: string,
    data?: Record<string, string | number | boolean>
  ) => Promise<void>;
};

export async function sendPushToUserIds(
  userIds: string[],
  title: string,
  body: string,
  data: Record<string, string> = {}
): Promise<void> {
  const sendPushToTokens = firebaseAdmin?.sendPushToTokens;
  if (!sendPushToTokens || !userIds.length) return;

  const uniqueIds = Array.from(new Set(userIds.filter(Boolean)));

  try {
    const tokenResult = await query(
      `SELECT token FROM user_push_tokens WHERE user_id = ANY($1::uuid[])`,
      [uniqueIds]
    );
    const tokens = (tokenResult.rows || [])
      .map((r: { token?: string }) => r.token)
      .filter((t): t is string => Boolean(t));

    if (tokens.length === 0) return;

    await sendPushToTokens(tokens, title, body || title, data);
  } catch (err: any) {
    console.warn('[firebasePushService] send failed:', err?.message || err);
  }
}
