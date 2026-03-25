import { generateOTP, createOTPVerification, verifyOTP } from '../otpService';

// Mock database
jest.mock('../../config/database', () => ({
  query: jest.fn(),
}));

import { query } from '../../config/database';

describe('OTP Service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('generateOTP', () => {
    it('should generate a 6-digit OTP', () => {
      const otp = generateOTP();
      expect(otp).toMatch(/^\d{6}$/);
    });
  });

  describe('createOTPVerification', () => {
    it('should create a new OTP verification', async () => {
      (query as jest.Mock).mockResolvedValueOnce({ rows: [] });
      (query as jest.Mock).mockResolvedValueOnce({ rows: [] });

      const mobile = '1234567890';
      const otp = await createOTPVerification(mobile);

      expect(otp).toMatch(/^\d{6}$/);
      expect(query).toHaveBeenCalled();
    });
  });

  describe('verifyOTP', () => {
    it('should verify a valid OTP', async () => {
      const mobile = '1234567890';
      const otpCode = '123456';
      const expiresAt = new Date();
      expiresAt.setMinutes(expiresAt.getMinutes() + 3);

      (query as jest.Mock).mockResolvedValueOnce({
        rows: [{
          id: 'test-id',
          otp_code: otpCode,
          attempts: 0,
          max_attempts: 3,
          expires_at: expiresAt,
        }],
      });
      (query as jest.Mock).mockResolvedValueOnce({ rows: [] });
      (query as jest.Mock).mockResolvedValueOnce({ rows: [] });

      const result = await verifyOTP(mobile, otpCode);
      expect(result).toBe(true);
    });

    it('should throw error for expired OTP', async () => {
      const mobile = '1234567890';
      const otpCode = '123456';
      const expiresAt = new Date();
      expiresAt.setMinutes(expiresAt.getMinutes() - 1); // Expired

      (query as jest.Mock).mockResolvedValueOnce({
        rows: [{
          id: 'test-id',
          otp_code: otpCode,
          attempts: 0,
          max_attempts: 3,
          expires_at: expiresAt,
        }],
      });

      await expect(verifyOTP(mobile, otpCode)).rejects.toThrow('OTP has expired');
    });
  });
});

