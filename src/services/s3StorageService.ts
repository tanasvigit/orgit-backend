/**
 * S3 storage abstraction for documents and media.
 * When AWS env vars are set, uploads go to S3; otherwise local disk is used.
 * We store the S3 key in DB and resolve to signed URLs at read time.
 */

import AWS from 'aws-sdk';

const BUCKET = process.env.AWS_S3_BUCKET || '';
const REGION = process.env.AWS_REGION || 'us-east-1';
const PREFIX = (process.env.AWS_S3_PREFIX || '').replace(/\/$/, '');
const SIGNED_URL_EXPIRY = parseInt(process.env.AWS_S3_SIGNED_URL_EXPIRY_SECONDS || '3600', 10);

function buildKey(prefixPath: string): string {
  const parts = [PREFIX, prefixPath].filter(Boolean);
  return parts.join('/');
}

let s3Client: AWS.S3 | null = null;

function getClient(): AWS.S3 {
  if (!s3Client) {
    const config: AWS.S3.ClientConfiguration = {
      region: REGION,
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    };
    if (process.env.AWS_S3_ENDPOINT) {
      config.endpoint = process.env.AWS_S3_ENDPOINT;
      config.s3ForcePathStyle = process.env.AWS_S3_FORCE_PATH_STYLE === 'true';
    }
    s3Client = new AWS.S3(config);
  }
  return s3Client;
}

/**
 * True when S3 should be used (bucket and credentials set).
 */
export function isConfigured(): boolean {
  if (!BUCKET) return false;
  if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) return true;
  return false;
}

/**
 * Upload a buffer to S3. key is the logical path (e.g. messages/uuid.ext).
 * Returns the full key (with optional prefix) to store in DB.
 */
export async function upload(
  key: string,
  body: Buffer,
  contentType?: string
): Promise<string> {
  const fullKey = buildKey(key);
  const client = getClient();
  const params: AWS.S3.PutObjectRequest = {
    Bucket: BUCKET,
    Key: fullKey,
    Body: body,
  };
  if (contentType) params.ContentType = contentType;
  await client.putObject(params).promise();
  return fullKey;
}

/**
 * Get a signed URL for reading. Use for private bucket.
 */
export function getSignedUrl(key: string, expiresInSeconds: number = SIGNED_URL_EXPIRY): string {
  const client = getClient();
  return client.getSignedUrl('getObject', {
    Bucket: BUCKET,
    Key: key,
    Expires: expiresInSeconds,
  });
}

/**
 * Resolve a stored value (S3 key or legacy local path) to a URL for the client.
 * - If value looks like S3 key (no leading slash, or known prefix), return signed URL.
 * - Otherwise return as-is (local path like /uploads/...).
 */
export function resolveToUrl(storedValue: string | null | undefined): string | null {
  if (!storedValue || typeof storedValue !== 'string') return null;
  const trimmed = storedValue.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('/uploads/') || trimmed.startsWith('http')) return trimmed;
  return getSignedUrl(trimmed);
}

/**
 * Check if a stored value is an S3 key (not a local path).
 */
export function isS3Key(storedValue: string | null | undefined): boolean {
  if (!storedValue || typeof storedValue !== 'string') return false;
  const t = storedValue.trim();
  if (t.startsWith('/') || t.startsWith('http')) return false;
  return true;
}

/**
 * Delete an object from S3 by key.
 */
export async function deleteObject(key: string): Promise<void> {
  const client = getClient();
  await client.deleteObject({ Bucket: BUCKET, Key: key }).promise();
}

/**
 * Get object body as Buffer (for streaming or download through API).
 */
export async function getObject(key: string): Promise<Buffer> {
  const client = getClient();
  const result = await client.getObject({ Bucket: BUCKET, Key: key }).promise();
  const body = result.Body;
  if (body instanceof Buffer) return body;
  if (Buffer.isBuffer(body)) return body;
  return Buffer.from(body as ArrayBuffer);
}
