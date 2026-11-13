const {
  normalizePhoneToE164,
  normalizeEmail,
  sanitizeString,
  extractDynamicCustomFields,
  transformGhlPayload,
} = require('../src/utils/sanitizer');

describe('Sanitizer and Normalizer Utilities', () => {
  describe('normalizePhoneToE164()', () => {
    it('formats a formatted 10-digit US phone number to E.164', () => {
      expect(normalizePhoneToE164('(415) 555-2671')).toBe('+14155552671');
      expect(normalizePhoneToE164('415-555-2671')).toBe('+14155552671');
    });

    it('formats an 11-digit US number starting with 1 to E.164', () => {
      expect(normalizePhoneToE164('1-800-555-0199')).toBe('+18005550199');
    });

    it('preserves international E.164 numbers with existing plus sign', () => {
      expect(normalizePhoneToE164('+44 20 7946 0958')).toBe('+442079460958');
    });

    it('returns null for invalid, too short, or empty inputs', () => {
      expect(normalizePhoneToE164('')).toBeNull();
      expect(normalizePhoneToE164(null)).toBeNull();
      expect(normalizePhoneToE164('12345')).toBeNull();
      expect(normalizePhoneToE164('not-a-phone')).toBeNull();
    });
  });

  describe('normalizeEmail()', () => {
    it('trims whitespace and lowercases valid email addresses', () => {
      expect(normalizeEmail('  John.Doe+VIP@Example.COM  ')).toBe('john.doe+vip@example.com');
    });

    it('returns null for malformed emails or non-strings', () => {
      expect(normalizeEmail('invalid-email')).toBeNull();
      expect(normalizeEmail('   ')).toBeNull();
      expect(normalizeEmail(null)).toBeNull();
    });
  });

  describe('sanitizeString()', () => {
    it('strips HTML tags, control characters, and normalizes spaces', () => {
      expect(sanitizeString('  <b>Alice</b>   <script>alert(1)</script>Smith \n\t ')).toBe(
        'Alice alert(1)Smith'
      );
    });

    it('returns null for empty strings after sanitization', () => {
      expect(sanitizeString('   <br/>  ')).toBeNull();
      expect(sanitizeString(undefined)).toBeNull();
    });
  });

  describe('extractDynamicCustomFields()', () => {
    it('extracts custom fields matching dynamic tags from customFields array and customData', () => {
      const rawPayload = {
        tags: ['UTM_Source', 'custom:annual_revenue', 'tier:enterprise'],
        customData: {
          utm_source: '  Google_Ads_Search ',
          untagged_extra: 'keep_me',
        },
        customFields: [
          { id: 'cf_1', key: 'contact.annual_revenue', value: '$250,000' },
          { id: 'cf_2', key: 'contact.unmatched_field', value: 'ignored' },
        ],
      };

      const { normalizedTags, extractedCustomFields } = extractDynamicCustomFields(rawPayload);

      expect(normalizedTags).toEqual(['utm_source', 'custom:annual_revenue', 'tier:enterprise']);
      expect(extractedCustomFields).toEqual({
        utm_source: 'Google_Ads_Search',
        annual_revenue: '$250,000',
        tier: 'enterprise',
        untagged_extra: 'keep_me',
      });
    });
  });

  describe('transformGhlPayload()', () => {
    it('produces a complete normalized canonical contact payload', () => {
      const rawPayload = {
        contact_id: 'ghl_cnt_998877',
        first_name: '  Sarah ',
        last_name: 'Connor ',
        email: 'SARAH.CONNOR@SKYNET.IO ',
        phone: '(310) 555-8899',
        locationId: 'loc_ca_01',
        tags: ['lead_source', 'priority:high'],
        lead_source: 'Facebook Lead Form',
      };

      const result = transformGhlPayload(rawPayload, 'track-1234');

      expect(result.trackingId).toBe('track-1234');
      expect(result.locationId).toBe('loc_ca_01');
      expect(result.contact).toEqual({
        contactId: 'ghl_cnt_998877',
        firstName: 'Sarah',
        lastName: 'Connor',
        fullName: 'Sarah Connor',
        email: 'sarah.connor@skynet.io',
        phone: '+13105558899',
        tags: ['lead_source', 'priority:high'],
      });
      expect(result.customFields).toEqual({
        lead_source: 'Facebook Lead Form',
        priority: 'high',
      });
    });
  });
});
