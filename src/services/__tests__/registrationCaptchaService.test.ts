import {
  createRegistrationCaptcha,
  verifyRegistrationCaptcha,
} from '../registrationCaptchaService';

describe('registrationCaptchaService', () => {
  it('creates and verifies a captcha once', () => {
    const { captchaId, code } = createRegistrationCaptcha();
    expect(captchaId).toBeTruthy();
    expect(code).toHaveLength(5);

    const ok = verifyRegistrationCaptcha(captchaId, code);
    expect(ok.valid).toBe(true);

    const reused = verifyRegistrationCaptcha(captchaId, code);
    expect(reused.valid).toBe(false);
  });

  it('rejects incorrect answers', () => {
    const { captchaId } = createRegistrationCaptcha();
    const bad = verifyRegistrationCaptcha(captchaId, 'ZZZZZ');
    expect(bad.valid).toBe(false);
  });
});
