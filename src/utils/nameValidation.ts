/**
 * Server-side name validation to prevent Stored XSS and injection.
 * - Rejects HTML/script tags and event handlers
 * - Allows only alphabets (Unicode letters), spaces, hyphens, apostrophes
 * - Enforces length 2-50 characters
 */

export const NAME_MIN_LENGTH = 2;
export const NAME_MAX_LENGTH = 50;

/** Pattern: letters (any language), spaces, hyphens, apostrophes only. No digits, no <>&" */
const VALID_NAME_REGEX = /^[\p{L}\p{M}\s\-']+$/u;

/** Characters that indicate HTML/script content - reject if present */
const HTML_SCRIPT_PATTERN = /<[^>]*>|<\/\s*script|on\w+\s*=|javascript\s*:|data\s*:/i;

export interface NameValidationResult {
  valid: boolean;
  error?: string;
  sanitized?: string;
}

/**
 * Check if string contains HTML or script-like content.
 */
export function containsHtmlOrScript(value: string): boolean {
  if (typeof value !== 'string') return true;
  return HTML_SCRIPT_PATTERN.test(value) || /[<>]/.test(value);
}

/**
 * Validate and optionally sanitize a name for safe storage.
 * - Trims and collapses internal spaces
 * - Rejects if contains HTML/script, invalid characters, or wrong length
 * - Returns sanitized string (trimmed, normalized spaces) when valid
 */
export function validateName(name: unknown): NameValidationResult {
  if (name == null || typeof name !== 'string') {
    return { valid: false, error: 'Name is required' };
  }

  const trimmed = name.trim();
  if (trimmed.length === 0) {
    return { valid: false, error: 'Name is required' };
  }

  if (trimmed.length < NAME_MIN_LENGTH) {
    return {
      valid: false,
      error: `Name must be at least ${NAME_MIN_LENGTH} characters`,
    };
  }

  if (trimmed.length > NAME_MAX_LENGTH) {
    return {
      valid: false,
      error: `Name must be at most ${NAME_MAX_LENGTH} characters`,
    };
  }

  if (containsHtmlOrScript(trimmed)) {
    return {
      valid: false,
      error: 'Name contains invalid characters (HTML or script not allowed)',
    };
  }

  if (!VALID_NAME_REGEX.test(trimmed)) {
    return {
      valid: false,
      error: 'Name can only contain letters, spaces, hyphens, and apostrophes',
    };
  }

  const sanitized = trimmed.replace(/\s+/g, ' ');
  return { valid: true, sanitized };
}
