import { randomBytes } from 'crypto';

const CAPTCHA_TTL_MS = 5 * 60 * 1000;
const CAPTCHA_CHARS = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

type CaptchaEntry = {
  answer: string;
  expiresAt: number;
};

const captchaStore = new Map<string, CaptchaEntry>();

function purgeExpiredCaptchas(): void {
  const now = Date.now();
  for (const [id, entry] of captchaStore.entries()) {
    if (entry.expiresAt <= now) captchaStore.delete(id);
  }
}

function generateCaptchaCode(length = 5): string {
  const bytes = randomBytes(length);
  let code = '';
  for (let i = 0; i < length; i += 1) {
    code += CAPTCHA_CHARS[bytes[i] % CAPTCHA_CHARS.length];
  }
  return code;
}

export function createRegistrationCaptcha(): { captchaId: string; code: string } {
  purgeExpiredCaptchas();
  const captchaId = randomBytes(16).toString('hex');
  const code = generateCaptchaCode();
  captchaStore.set(captchaId, {
    answer: code,
    expiresAt: Date.now() + CAPTCHA_TTL_MS,
  });
  return { captchaId, code };
}

export function verifyRegistrationCaptcha(
  captchaId: string | null | undefined,
  captchaAnswer: string | null | undefined
): { valid: boolean; error?: string } {
  purgeExpiredCaptchas();
  const id = String(captchaId || '').trim();
  const answer = String(captchaAnswer || '').trim().toUpperCase();

  if (!id) {
    return { valid: false, error: 'Captcha is required' };
  }
  if (!answer) {
    return { valid: false, error: 'Please type the captcha code' };
  }
  if (!/^[23456789A-Z]{5}$/.test(answer)) {
    return { valid: false, error: 'Captcha must be 5 characters' };
  }

  const entry = captchaStore.get(id);
  captchaStore.delete(id);

  if (!entry) {
    return { valid: false, error: 'Captcha expired or invalid. Please refresh and try again.' };
  }
  if (entry.expiresAt <= Date.now()) {
    return { valid: false, error: 'Captcha expired. Please refresh and try again.' };
  }
  if (entry.answer !== answer) {
    return { valid: false, error: 'Invalid security code. Please try again.' };
  }

  return { valid: true };
}
