import {
  validateName,
  containsHtmlOrScript,
  NAME_MIN_LENGTH,
  NAME_MAX_LENGTH,
} from '../nameValidation';

describe('nameValidation', () => {
  describe('validateName', () => {
    it('accepts valid names with letters and spaces', () => {
      expect(validateName('John Doe').valid).toBe(true);
      expect(validateName('John Doe').sanitized).toBe('John Doe');
      expect(validateName('  Jane   Smith  ').valid).toBe(true);
      expect(validateName('  Jane   Smith  ').sanitized).toBe('Jane Smith');
    });

    it('accepts hyphens and apostrophes', () => {
      expect(validateName("Mary-Jane O'Brien").valid).toBe(true);
      expect(validateName('Jean-Pierre').valid).toBe(true);
    });

    it('enforces minimum length', () => {
      const r = validateName('A');
      expect(r.valid).toBe(false);
      expect(r.error).toMatch(/at least 2/);
    });

    it('enforces maximum length', () => {
      const long = 'a'.repeat(NAME_MAX_LENGTH + 1);
      const r = validateName(long);
      expect(r.valid).toBe(false);
      expect(r.error).toMatch(/at most 50/);
    });

    it('accepts exactly 2 and 50 characters', () => {
      expect(validateName('Ab').valid).toBe(true);
      expect(validateName('a'.repeat(50)).valid).toBe(true);
    });

    it('rejects null and empty', () => {
      expect(validateName(null).valid).toBe(false);
      expect(validateName('').valid).toBe(false);
      expect(validateName('   ').valid).toBe(false);
    });

    describe('XSS payloads - must be rejected', () => {
      const xssPayloads = [
        '<script>alert(1)</script>',
        '<img src=x onerror=alert(1)>',
        '<svg/onload=alert(1)>',
        '<script>alert("xss")</script>',
        '"><script>alert(1)</script>',
        '<iframe src="javascript:alert(1)">',
        '<body onload=alert(1)>',
        'javascript:alert(1)',
        '<img src=x onerror=alert(1)>',
        '"><img src=x onerror=alert(1)>',
      ];

      xssPayloads.forEach((payload) => {
        it(`rejects: ${payload.substring(0, 40)}...`, () => {
          const r = validateName(payload);
          expect(r.valid).toBe(false);
          expect(r.sanitized).toBeUndefined();
        });
      });
    });

    it('rejects names containing < or >', () => {
      expect(validateName('John<Doe').valid).toBe(false);
      expect(validateName('John>Doe').valid).toBe(false);
      expect(validateName('<>').valid).toBe(false);
    });

    it('rejects digits and special chars (except hyphen apostrophe)', () => {
      expect(validateName('John123').valid).toBe(false);
      expect(validateName('John@Doe').valid).toBe(false);
      expect(validateName('John$Doe').valid).toBe(false);
    });
  });

  describe('containsHtmlOrScript', () => {
    it('detects script tags', () => {
      expect(containsHtmlOrScript('<script>alert(1)</script>')).toBe(true);
      expect(containsHtmlOrScript('</script>')).toBe(true);
    });

    it('detects event handlers', () => {
      expect(containsHtmlOrScript('onerror=alert(1)')).toBe(true);
      expect(containsHtmlOrScript('onload=alert(1)')).toBe(true);
    });

    it('detects angle brackets', () => {
      expect(containsHtmlOrScript('hello<world')).toBe(true);
      expect(containsHtmlOrScript('hello>world')).toBe(true);
    });

    it('returns false for safe text', () => {
      expect(containsHtmlOrScript("John O'Brien")).toBe(false);
      expect(containsHtmlOrScript('Mary-Jane')).toBe(false);
    });
  });
});
