/**
 * Firebase Admin SDK for sending FCM push notifications.
 * Requires FIREBASE_SERVICE_ACCOUNT_PATH or GOOGLE_APPLICATION_CREDENTIALS in .env.
 * If not set, getMessaging() returns null and sendPushToTokens is a no-op.
 */
const admin = require('firebase-admin');
const path = require('path');
const fs = require('fs');

let messagingInstance = null;

function init() {
  if (messagingInstance !== null) return messagingInstance;
  try {
    const credPath =
      process.env.FIREBASE_SERVICE_ACCOUNT_PATH ||
      process.env.GOOGLE_APPLICATION_CREDENTIALS;
    if (!credPath) {
      console.warn('Firebase: No FIREBASE_SERVICE_ACCOUNT_PATH or GOOGLE_APPLICATION_CREDENTIALS set; push notifications disabled.');
      return null;
    }
    const resolvedPath = path.isAbsolute(credPath)
      ? credPath
      : path.resolve(process.cwd(), credPath);
    const serviceAccount = JSON.parse(fs.readFileSync(resolvedPath, 'utf8'));
    if (!admin.apps.length) {
      admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    }
    messagingInstance = admin.messaging();
    console.log('Firebase Admin initialized for FCM.');
    return messagingInstance;
  } catch (err) {
    console.warn('Firebase Admin init failed:', err.message);
    return null;
  }
}

function getMessaging() {
  if (messagingInstance === null) init();
  return messagingInstance;
}

/**
 * Send FCM notification to one or more tokens. Fire-and-forget; logs errors.
 * @param {string[]} tokens - FCM device tokens
 * @param {string} title - Notification title
 * @param {string} body - Notification body
 * @param {object} data - Optional data payload (e.g. { conversationId, type: 'message' })
 */
async function sendPushToTokens(tokens, title, body, data = {}) {
  const messaging = getMessaging();
  if (!messaging || !tokens || tokens.length === 0) return;
  try {
    if (tokens.length === 1) {
      await messaging.send({
        token: tokens[0],
        notification: { title, body },
        data: { ...Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])) },
        android: { priority: 'high' },
        apns: { payload: { aps: { sound: 'default' } } },
      });
    } else {
      const result = await messaging.sendEachForMulticast({
        tokens,
        notification: { title, body },
        data: { ...Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])) },
        android: { priority: 'high' },
        apns: { payload: { aps: { sound: 'default' } } },
      });
      if (result.failureCount > 0) {
        result.responses.forEach((resp, i) => {
          if (!resp.success) console.warn('FCM send failed for token index', i, resp.error?.message);
        });
      }
    }
  } catch (err) {
    console.error('FCM send error:', err.message);
  }
}

module.exports = { getMessaging, sendPushToTokens, init };
