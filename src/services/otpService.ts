import { query } from '../config/database';
import { v4 as uuidv4 } from 'uuid';

const OTP_EXPIRY_MINUTES = parseInt(process.env.OTP_EXPIRY_MINUTES || '3', 10);
const OTP_MAX_ATTEMPTS = parseInt(process.env.OTP_MAX_ATTEMPTS || '3', 10);

export interface OTPVerification {
  id: string;
  mobile: string;
  otpCode: string;
  attempts: number;
  maxAttempts: number;
  expiresAt: Date;
  verifiedAt?: Date;
  createdAt: Date;
}

/**
 * Generate a 6-digit OTP code
 */
export const generateOTP = (): string => {
  return Math.floor(100000 + Math.random() * 900000).toString();
};

/**
 * Create or update OTP verification record
 */
export const createOTPVerification = async (mobile: string): Promise<string> => {
  const otpCode = generateOTP();
  const expiresAt = new Date();
  expiresAt.setMinutes(expiresAt.getMinutes() + OTP_EXPIRY_MINUTES);

  // Check if there's an existing unverified OTP
  const existingResult = await query(
    `SELECT id FROM otp_verifications 
     WHERE mobile = $1 AND verified_at IS NULL AND expires_at > NOW()`,
    [mobile]
  );

  if (existingResult.rows.length > 0) {
    // Update existing OTP
    await query(
      `UPDATE otp_verifications 
       SET otp_code = $1, expires_at = $2, attempts = 0, created_at = NOW()
       WHERE id = $3`,
      [otpCode, expiresAt, existingResult.rows[0].id]
    );
  } else {
    // Create new OTP
    await query(
      `INSERT INTO otp_verifications (id, mobile, otp_code, expires_at, attempts, max_attempts)
       VALUES (gen_random_uuid(), $1, $2, $3, 0, $4)`,
      [mobile, otpCode, expiresAt, OTP_MAX_ATTEMPTS]
    );
  }

  // TODO: Send OTP via SMS service (Twilio, AWS SNS, etc.)
  // For now, we'll just return the OTP (remove this in production)
  console.log(`OTP for ${mobile}: ${otpCode}`);

  return otpCode;
};

/**
 * Verify OTP code
 */
export const verifyOTP = async (mobile: string, otpCode: string): Promise<boolean> => {
  const result = await query(
    `SELECT id, otp_code, attempts, max_attempts, expires_at, verified_at
     FROM otp_verifications
     WHERE mobile = $1 AND verified_at IS NULL
     ORDER BY created_at DESC
     LIMIT 1`,
    [mobile]
  );

  if (result.rows.length === 0) {
    throw new Error('No OTP found for this mobile number');
  }

  const otpRecord = result.rows[0];

  // Check if OTP has expired
  if (new Date(otpRecord.expires_at) < new Date()) {
    throw new Error('OTP has expired');
  }

  // Check if max attempts exceeded
  if (otpRecord.attempts >= otpRecord.max_attempts) {
    throw new Error('Maximum OTP verification attempts exceeded');
  }

  // Increment attempts
  await query(
    `UPDATE otp_verifications 
     SET attempts = attempts + 1
     WHERE id = $1`,
    [otpRecord.id]
  );

  // Verify OTP code
  if (otpRecord.otp_code !== otpCode) {
    throw new Error('Invalid OTP code');
  }

  // Mark as verified
  await query(
    `UPDATE otp_verifications 
     SET verified_at = NOW()
     WHERE id = $1`,
    [otpRecord.id]
  );

  return true;
};

/**
 * Check if OTP is verified for a mobile number
 */
export const isOTPVerified = async (mobile: string): Promise<boolean> => {
  const result = await query(
    `SELECT verified_at FROM otp_verifications
     WHERE mobile = $1 AND verified_at IS NOT NULL
     ORDER BY created_at DESC
     LIMIT 1`,
    [mobile]
  );

  return result.rows.length > 0;
};

