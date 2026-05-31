/**
 * Stack Exchange Compact Output Formatter Unit Tests
 *
 * Tests pure functions for formatting results in compact format.
 * Tests focus on core functionality and edge cases, not every permutation.
 */

import { describe, it, expect } from 'vitest';
import {
  formatQuestionsCompact,
  formatAnswersCompact,
  formatUsersCompact,
  formatSitesCompact,
} from '../../../../src/stackexchange/output/compact';

describe('stackexchange/output/compact', () => {
  describe('formatQuestionsCompact', () => {
    it('should format empty questions list', () => {
      const result = formatQuestionsCompact([]);
      expect(result).toBe('No questions found.');
    });

    it('should format questions with accepted answers', () => {
      const questions = [
        {
          title: 'Test question with answer',
          link: 'https://stackoverflow.com/q/123',
          score: 10,
          answer_count: 5,
          view_count: 100,
          accepted_answer_id: 456,
        } as any,
        {
          title: 'Unanswered question',
          link: 'https://stackoverflow.com/q/124',
          score: 5,
          answer_count: 0,
          view_count: 50,
          accepted_answer_id: null,
        } as any,
      ];
      const result = formatQuestionsCompact(questions);

      expect(result).toContain('1.');
      expect(result).toContain('[accepted]'); // Accepted answer indicator
      expect(result).toContain('Test question with answer');
      expect(result).toContain('2.');
      expect(result).toContain('Unanswered question');
      expect(result).toContain('(5 pts, 0 ans, 50 views)'); // Unanswered
    });

    it('should handle edge cases in question data', () => {
      const questions = [
        {
          title: '', // Empty title
          link: 'https://stackoverflow.com/q/125',
          score: -5, // Negative score
          answer_count: 2,
          view_count: 10,
          accepted_answer_id: 456,
        } as any,
        {
          title: 'Question with <html> & "quotes"',
          link: 'https://stackoverflow.com/q/126',
          score: 9999, // Large numbers
          answer_count: 500,
          view_count: 1000000,
          accepted_answer_id: 456,
        } as any,
      ];
      const result = formatQuestionsCompact(questions);

      // Should handle empty title
      expect(result).toContain('[]');
      // Should handle negative score
      expect(result).toContain('(-5 pts');
      // Should handle special characters
      expect(result).toContain('<html> & "quotes"');
      // Should handle large numbers
      expect(result).toContain('9999 pts, 500 ans, 1000000 views');
    });

    it('should handle unicode in titles', () => {
      const questions = [
        {
          title: 'Question 日本語 Тест emoji 🎉',
          link: 'https://stackoverflow.com/q/127',
          score: 10,
          answer_count: 5,
          view_count: 100,
          accepted_answer_id: 456,
        } as any,
      ];
      const result = formatQuestionsCompact(questions);

      expect(result).toContain('日本語');
      expect(result).toContain('Тест');
      expect(result).toContain('🎉');
    });
  });

  describe('formatAnswersCompact', () => {
    it('should format empty answers list', () => {
      const result = formatAnswersCompact([]);
      expect(result).toBe('No answers found.');
    });

    it('should format answers with acceptance status', () => {
      const answers = [
        {
          is_accepted: true,
          score: 15,
          owner: { display_name: 'User1' },
        } as any,
        {
          is_accepted: false,
          score: 5,
          owner: { display_name: 'User2' },
        } as any,
        {
          is_accepted: false,
          score: -3,
          owner: { display_name: 'User3' },
        } as any,
      ];
      const result = formatAnswersCompact(answers);

      expect(result).toContain('1.');
      expect(result).toContain('[accepted]'); // Accepted
      expect(result).toContain('by User1');
      expect(result).toContain('(15 pts)');
      
      expect(result).toContain('2.');
      expect(result).toContain('by User2');
      expect(result).toContain('(5 pts)');
      
      expect(result).toContain('3.');
      expect(result).toContain('(-3 pts)'); // Negative score
    });

    it('should handle missing owner information', () => {
      const answers = [
        {
          is_accepted: true,
          score: 10,
          owner: null as any,
        } as any,
        {
          is_accepted: false,
          score: 5,
          owner: undefined,
        } as any,
        {
          is_accepted: false,
          score: 3,
          owner: { display_name: '' },
        } as any,
      ];
      const result = formatAnswersCompact(answers);

      expect(result).toContain('by Unknown'); // null owner
      expect(result).toContain('by Unknown'); // undefined owner
      expect(result).toContain('by '); // empty display_name
    });

    it('should handle unicode in display names', () => {
      const answers = [
        {
          is_accepted: true,
          score: 10,
          owner: { display_name: '日本語 User 🎉' },
        } as any,
      ];
      const result = formatAnswersCompact(answers);

      expect(result).toContain('日本語 User 🎉');
    });
  });

  describe('formatUsersCompact', () => {
    it('should format empty users list', () => {
      const result = formatUsersCompact([]);
      expect(result).toBe('No users found.');
    });

    it('should format users with badge counts', () => {
      const users = [
        {
          display_name: 'ExpertUser',
          reputation: 1000,
          badge_counts: {
            gold: 5,
            silver: 10,
            bronze: 20,
          },
        } as any,
        {
          display_name: 'NewUser',
          reputation: 1,
          badge_counts: {
            gold: 0,
            silver: 0,
            bronze: 0,
          },
        } as any,
        {
          display_name: 'NegativeRepUser',
          reputation: -10,
          badge_counts: {
            gold: 0,
            silver: 0,
            bronze: 0,
          },
        } as any,
      ];
      const result = formatUsersCompact(users);

      expect(result).toContain('ExpertUser');
      expect(result).toContain('rep: 1000');
      expect(result).toContain('gold:5');
      expect(result).toContain('silver:10');
      expect(result).toContain('bronze:20');
      
      expect(result).toContain('NewUser');
      expect(result).toContain('rep: 1');
      expect(result).toContain('gold:0');
      
      expect(result).toContain('rep: -10'); // Negative reputation
    });

    it('should handle missing badge counts', () => {
      const users = [
        {
          display_name: 'TestUser',
          reputation: 1000,
          badge_counts: null as any,
        } as any,
      ];
      const result = formatUsersCompact(users);

      expect(result).toContain('TestUser');
      expect(result).toContain('gold:0'); // Should default to 0
    });

    it('should handle unicode in display names', () => {
      const users = [
        {
          display_name: '日本語 User 🎉',
          reputation: 1000,
          badge_counts: { gold: 5, silver: 10, bronze: 20 },
        } as any,
      ];
      const result = formatUsersCompact(users);

      expect(result).toContain('日本語 User 🎉');
    });
  });

  describe('formatSitesCompact', () => {
    it('should format empty sites list', () => {
      const result = formatSitesCompact([]);
      expect(result).toBe('No sites found.');
    });

    it('should format sites with audience', () => {
      const sites = [
        {
          name: 'Stack Overflow',
          api_site_parameter: 'stackoverflow',
          audience: 'Professional and enthusiast programmers',
        } as any,
        {
          name: 'Test Site',
          api_site_parameter: 'testsite',
          audience: null,
        } as any,
        {
          name: 'Another Site',
          api_site_parameter: 'another',
          audience: undefined,
        } as any,
      ];
      const result = formatSitesCompact(sites);

      expect(result).toContain('Stack Overflow');
      expect(result).toContain('`stackoverflow`');
      expect(result).toContain('Professional and enthusiast programmers');
      
      expect(result).toContain('Test Site');
      expect(result).toContain('`testsite`');
      expect(result).toContain('N/A'); // null audience
      
      expect(result).toContain('Another Site');
      expect(result).toContain('`another`');
      expect(result).toContain('N/A'); // undefined audience
    });

    it('should handle unicode in site names', () => {
      const sites = [
        {
          name: '日本語 サイト 🎉',
          api_site_parameter: 'japanese-site',
          audience: 'Japanese users',
        } as any,
      ];
      const result = formatSitesCompact(sites);

      expect(result).toContain('日本語 サイト 🎉');
    });

    it('should handle missing fields gracefully', () => {
      const sites = [
        {
          name: undefined,
          api_site_parameter: 'test',
          audience: 'Test audience',
        } as any,
        {
          name: 'Test Site',
          api_site_parameter: undefined,
          audience: 'Test',
        } as any,
      ];
      const result = formatSitesCompact(sites);

      // Should handle undefined name
      expect(result).toContain('`test`');
      // Should handle undefined api_site_parameter
      expect(result).toContain('Test Site');
      expect(result).toContain('`undefined`');
    });
  });
});