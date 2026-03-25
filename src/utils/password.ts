import bcrypt from 'bcryptjs';

const SALT_ROUNDS = 10;

/**
 * Hash a password using bcrypt
 * @param password - Plain text password
 * @returns Hashed password
 */
export const hashPassword = async (password: string): Promise<string> => {
  if (!password || password.trim().length === 0) {
    throw new Error('Password cannot be empty');
  }
  return await bcrypt.hash(password, SALT_ROUNDS);
};

/**
 * Compare a plain text password with a hashed password
 * @param password - Plain text password
 * @param hash - Hashed password from database
 * @returns True if passwords match, false otherwise
 */
export const comparePassword = async (password: string, hash: string): Promise<boolean> => {
  if (!password || !hash) {
    console.log('[comparePassword] Missing password or hash:', { hasPassword: !!password, hasHash: !!hash });
    return false;
  }
  
  // Trim password to handle any accidental whitespace
  const trimmedPassword = password.trim();
  
  try {
    const result = await bcrypt.compare(trimmedPassword, hash);
    if (!result) {
      console.log('[comparePassword] Password comparison failed');
      console.log('[comparePassword] Password length:', trimmedPassword.length);
      console.log('[comparePassword] Hash starts with:', hash.substring(0, 10));
    }
    return result;
  } catch (error: any) {
    console.error('[comparePassword] Error during comparison:', error.message);
    return false;
  }
};

