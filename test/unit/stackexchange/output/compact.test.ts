/**
 * Stack Exchange Compact Output Formatter Unit Tests
 *
 * Tests pure functions for formatting results in compact format.
 * No external dependencies required.
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
    describe('positive cases', () => {
      it('should format empty questions list', () => {
        const result = formatQuestionsCompact([]);
        expect(result).toBe('No questions found.');
      });

      it('should format single question', () => {
        const questions = [
          {
            title: 'Test question',
            link: 'https://stackoverflow.com/q/123',
            score: 10,
            answer_count: 5,
            view_count: 100,
            accepted_answer_id: 456,
          } as any,
        ];
        const result = formatQuestionsCompact(questions);

        expect(result).toContain('1.');
        expect(result).toContain('✓');
        expect(result).toContain('[Test question]');
        expect(result).toContain('(https://stackoverflow.com/q/123)');
        expect(result).toContain('(10 pts, 5 ans, 100 views)');
      });

      it('should format multiple questions', () => {
        const questions = [
          {
            title: 'First question',
            link: 'https://stackoverflow.com/q/1',
            score: 10,
            answer_count: 5,
            view_count: 100,
            accepted_answer_id: 1,
          } as any,
          {
            title: 'Second question',
            link: 'https://stackoverflow.com/q/2',
            score: 20,
            answer_count: 10,
            view_count: 200,
            accepted_answer_id: 2,
          } as any,
        ];
        const result = formatQuestionsCompact(questions);

        expect(result).toContain('1.');
        expect(result).toContain('2.');
        expect(result).toContain('First question');
        expect(result).toContain('Second question');
      });

      it('should format question without accepted answer', () => {
        const questions = [
          {
            title: 'Unanswered question',
            link: 'https://stackoverflow.com/q/123',
            score: 5,
            answer_count: 2,
            view_count: 50,
            accepted_answer_id: null,
          } as any,
        ];
        const result = formatQuestionsCompact(questions);

        expect(result).toContain('1.');
        expect(result).toContain(' [Unanswered question]');
        expect(result).not.toContain('✓');
      });

      it('should format question with zero answers', () => {
        const questions = [
          {
            title: 'No answers yet',
            link: 'https://stackoverflow.com/q/123',
            score: 1,
            answer_count: 0,
            view_count: 10,
            accepted_answer_id: null,
          } as any,
        ];
        const result = formatQuestionsCompact(questions);

        expect(result).toContain('(1 pts, 0 ans, 10 views)');
      });

      it('should format question with special characters in title', () => {
        const questions = [
          {
            title: 'Question with <html> & "quotes" and \'apostrophes\'',
            link: 'https://stackoverflow.com/q/123',
            score: 5,
            answer_count: 3,
            view_count: 100,
            accepted_answer_id: 456,
          } as any,
        ];
        const result = formatQuestionsCompact(questions);

        expect(result).toContain('Question with <html> & "quotes" and \'apostrophes\'');
      });

      it('should format question with unicode', () => {
        const questions = [
          {
            title: 'Question 日本語 Тест emoji 🎉',
            link: 'https://stackoverflow.com/q/123',
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

      it('should format question with negative score', () => {
        const questions = [
          {
            title: 'Downvoted question',
            link: 'https://stackoverflow.com/q/123',
            score: -5,
            answer_count: 2,
            view_count: 10,
            accepted_answer_id: 456,
          } as any,
        ];
        const result = formatQuestionsCompact(questions);

        expect(result).toContain('(-5 pts, 2 ans, 10 views)');
      });

      it('should format question with large numbers', () => {
        const questions = [
          {
            title: 'Popular question',
            link: 'https://stackoverflow.com/q/123',
            score: 9999,
            answer_count: 500,
            view_count: 1000000,
            accepted_answer_id: 456,
          } as any,
        ];
        const result = formatQuestionsCompact(questions);

        expect(result).toContain('(9999 pts, 500 ans, 1000000 views)');
      });
    });

    describe('negative cases', () => {
      it('should handle empty title', () => {
        const questions = [
          {
            title: '',
            link: 'https://stackoverflow.com/q/123',
            score: 5,
            answer_count: 2,
            view_count: 10,
            accepted_answer_id: 456,
          } as any,
        ];
        const result = formatQuestionsCompact(questions);

        expect(result).toContain('1.');
        expect(result).toContain('[]');
      });

      it('should handle undefined title', () => {
        const questions = [
          {
            title: undefined,
            link: 'https://stackoverflow.com/q/123',
            score: 5,
            answer_count: 2,
            view_count: 10,
            accepted_answer_id: 456,
          } as any,
        ];
        const result = formatQuestionsCompact(questions);

        expect(result).toContain('1.');
        expect(result).toContain('[undefined]'); // Shows as string "undefined"
      });
    });

    describe('edge cases', () => {
      it('should format very long title', () => {
        const longTitle = 'A'.repeat(1000);
        const questions = [
          {
            title: longTitle,
            link: 'https://stackoverflow.com/q/123',
            score: 5,
            answer_count: 2,
            view_count: 10,
            accepted_answer_id: 456,
          } as any,
        ];
        const result = formatQuestionsCompact(questions);

        expect(result).toContain(longTitle);
      });

      it('should format empty accepted_answer_id (falsy)', () => {
        const questions = [
          {
            title: 'Question',
            link: 'https://stackoverflow.com/q/123',
            score: 5,
            answer_count: 2,
            view_count: 10,
            accepted_answer_id: 0, // falsy value
          } as any,
        ];
        const result = formatQuestionsCompact(questions);

        expect(result).not.toContain('✓');
      });
    });
  });

  describe('formatAnswersCompact', () => {
    describe('positive cases', () => {
      it('should format empty answers list', () => {
        const result = formatAnswersCompact([]);
        expect(result).toBe('No answers found.');
      });

      it('should format single answer', () => {
        const answers = [
          {
            is_accepted: true,
            score: 15,
            owner: {
              display_name: 'TestUser',
            },
          } as any,
        ];
        const result = formatAnswersCompact(answers);

        expect(result).toContain('1.');
        expect(result).toContain('✓');
        expect(result).toContain('by TestUser');
        expect(result).toContain('(15 pts)');
      });

      it('should format multiple answers', () => {
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
        ];
        const result = formatAnswersCompact(answers);

        expect(result).toContain('1.');
        expect(result).toContain('2.');
        expect(result).toContain('User1');
        expect(result).toContain('User2');
      });

      it('should format non-accepted answer', () => {
        const answers = [
          {
            is_accepted: false,
            score: 10,
            owner: { display_name: 'TestUser' },
          } as any,
        ];
        const result = formatAnswersCompact(answers);

        expect(result).toContain('1.');
        expect(result).not.toContain('✓');
        expect(result).toContain('by TestUser');
      });

      it('should format answer without owner', () => {
        const answers = [
          {
            is_accepted: true,
            score: 10,
            owner: undefined,
          } as any,
        ];
        const result = formatAnswersCompact(answers);

        expect(result).toContain('by Unknown');
      });

      it('should format answer with negative score', () => {
        const answers = [
          {
            is_accepted: false,
            score: -5,
            owner: { display_name: 'Downvoted' },
          } as any,
        ];
        const result = formatAnswersCompact(answers);

        expect(result).toContain('(-5 pts)');
      });

      it('should format answer with zero score', () => {
        const answers = [
          {
            is_accepted: true,
            score: 0,
            owner: { display_name: 'Neutral' },
          } as any,
        ];
        const result = formatAnswersCompact(answers);

        expect(result).toContain('(0 pts)');
      });

      it('should format answer with unicode display name', () => {
        const answers = [
          {
            is_accepted: true,
            score: 10,
            owner: { display_name: '日本語 User' },
          } as any,
        ];
        const result = formatAnswersCompact(answers);

        expect(result).toContain('日本語 User');
      });

      it('should format answer with emoji in display name', () => {
        const answers = [
          {
            is_accepted: true,
            score: 10,
            owner: { display_name: '🎉 User' },
          } as any,
        ];
        const result = formatAnswersCompact(answers);

        expect(result).toContain('🎉 User');
      });
    });

    describe('negative cases', () => {
      it('should handle null owner', () => {
        const answers = [
          {
            is_accepted: true,
            score: 10,
            owner: null as any,
          } as any,
        ];
        const result = formatAnswersCompact(answers);

        expect(result).toContain('by Unknown');
      });

      it('should handle undefined display_name', () => {
        const answers = [
          {
            is_accepted: true,
            score: 10,
            owner: { display_name: undefined },
          } as any,
        ];
        const result = formatAnswersCompact(answers);

        expect(result).toContain('by Unknown');
      });

      it('should handle empty display_name', () => {
        const answers = [
          {
            is_accepted: true,
            score: 10,
            owner: { display_name: '' },
          } as any,
        ];
        const result = formatAnswersCompact(answers);

        expect(result).toContain('by ');
      });
    });

    describe('edge cases', () => {
      it('should format answer with very long display name', () => {
        const longName = 'A'.repeat(1000);
        const answers = [
          {
            is_accepted: true,
            score: 10,
            owner: { display_name: longName },
          } as any,
        ];
        const result = formatAnswersCompact(answers);

        expect(result).toContain(longName);
      });

      it('should format answer with large score', () => {
        const answers = [
          {
            is_accepted: true,
            score: 99999,
            owner: { display_name: 'TopUser' },
          } as any,
        ];
        const result = formatAnswersCompact(answers);

        expect(result).toContain('(99999 pts)');
      });
    });
  });

  describe('formatUsersCompact', () => {
    describe('positive cases', () => {
      it('should format empty users list', () => {
        const result = formatUsersCompact([]);
        expect(result).toBe('No users found.');
      });

      it('should format single user', () => {
        const users = [
          {
            display_name: 'TestUser',
            reputation: 1000,
            badge_counts: {
              gold: 5,
              silver: 10,
              bronze: 20,
            },
          } as any,
        ];
        const result = formatUsersCompact(users);

        expect(result).toContain('1.');
        expect(result).toContain('TestUser');
        expect(result).toContain('rep: 1000'); // No parentheses
        expect(result).toContain('🥇5');
        expect(result).toContain('🥈10');
        expect(result).toContain('🥉20');
      });

      it('should format multiple users', () => {
        const users = [
          {
            display_name: 'User1',
            reputation: 1000,
            badge_counts: { gold: 5, silver: 10, bronze: 20 },
          } as any,
          {
            display_name: 'User2',
            reputation: 2000,
            badge_counts: { gold: 10, silver: 20, bronze: 30 },
          } as any,
        ];
        const result = formatUsersCompact(users);

        expect(result).toContain('1.');
        expect(result).toContain('2.');
        expect(result).toContain('User1');
        expect(result).toContain('User2');
      });

      it('should format user with zero badges', () => {
        const users = [
          {
            display_name: 'NewUser',
            reputation: 1,
            badge_counts: { gold: 0, silver: 0, bronze: 0 },
          } as any,
        ];
        const result = formatUsersCompact(users);

        expect(result).toContain('🥇0');
        expect(result).toContain('🥈0');
        expect(result).toContain('🥉0');
      });

      it('should format user with high reputation', () => {
        const users = [
          {
            display_name: 'ExpertUser',
            reputation: 1000000,
            badge_counts: { gold: 100, silver: 200, bronze: 300 },
          } as any,
        ];
        const result = formatUsersCompact(users);

        expect(result).toContain('rep: 1000000'); // No parentheses
      });

      it('should format user with negative reputation', () => {
        const users = [
          {
            display_name: 'DownvotedUser',
            reputation: -10,
            badge_counts: { gold: 0, silver: 0, bronze: 0 },
          } as any,
        ];
        const result = formatUsersCompact(users);

        expect(result).toContain('rep: -10'); // No parentheses
      });

      it('should format user with unicode display name', () => {
        const users = [
          {
            display_name: '日本語 User',
            reputation: 1000,
            badge_counts: { gold: 5, silver: 10, bronze: 20 },
          } as any,
        ];
        const result = formatUsersCompact(users);

        expect(result).toContain('日本語 User');
      });

      it('should format user with emoji in display name', () => {
        const users = [
          {
            display_name: '🎉 User',
            reputation: 1000,
            badge_counts: { gold: 5, silver: 10, bronze: 20 },
          } as any,
        ];
        const result = formatUsersCompact(users);

        expect(result).toContain('🎉 User');
      });
    });

    describe('negative cases', () => {
      it('should handle undefined display_name', () => {
        const users = [
          {
            display_name: undefined,
            reputation: 1000,
            badge_counts: { gold: 5, silver: 10, bronze: 20 },
          } as any,
        ];
        const result = formatUsersCompact(users);

        expect(result).toContain('1.');
        expect(result).toContain('rep: 1000'); // No parentheses
      });

      it('should handle null badge_counts (BUG: crashes)', () => {
        const users = [
          {
            display_name: 'TestUser',
            reputation: 1000,
            badge_counts: null as any,
          } as any,
        ];
        // This will crash with "Cannot read properties of null"
        // Documented as a bug
        expect(() => formatUsersCompact(users)).toThrow();
      });
    });

    describe('edge cases', () => {
      it('should format user with very long display name', () => {
        const longName = 'A'.repeat(1000);
        const users = [
          {
            display_name: longName,
            reputation: 1000,
            badge_counts: { gold: 5, silver: 10, bronze: 20 },
          } as any,
        ];
        const result = formatUsersCompact(users);

        expect(result).toContain(longName);
      });

      it('should format user with large badge counts', () => {
        const users = [
          {
            display_name: 'BadgeMaster',
            reputation: 1000,
            badge_counts: { gold: 9999, silver: 9999, bronze: 9999 },
          } as any,
        ];
        const result = formatUsersCompact(users);

        expect(result).toContain('🥇9999');
        expect(result).toContain('🥈9999');
        expect(result).toContain('🥉9999');
      });
    });
  });

  describe('formatSitesCompact', () => {
    describe('positive cases', () => {
      it('should format empty sites list', () => {
        const result = formatSitesCompact([]);
        expect(result).toBe('No sites found.');
      });

      it('should format single site', () => {
        const sites = [
          {
            name: 'Stack Overflow',
            api_site_parameter: 'stackoverflow',
            audience: 'Professional and enthusiast programmers',
          } as any,
        ];
        const result = formatSitesCompact(sites);

        expect(result).toContain('1.');
        expect(result).toContain('Stack Overflow');
        expect(result).toContain('`stackoverflow`');
        expect(result).toContain('Professional and enthusiast programmers');
      });

      it('should format multiple sites', () => {
        const sites = [
          {
            name: 'Stack Overflow',
            api_site_parameter: 'stackoverflow',
            audience: 'Programmers',
          } as any,
          {
            name: 'Super User',
            api_site_parameter: 'superuser',
            audience: 'Computer enthusiasts',
          } as any,
        ];
        const result = formatSitesCompact(sites);

        expect(result).toContain('1.');
        expect(result).toContain('2.');
        expect(result).toContain('Stack Overflow');
        expect(result).toContain('Super User');
      });

      it('should format site without audience', () => {
        const sites = [
          {
            name: 'Test Site',
            api_site_parameter: 'testsite',
            audience: null,
          } as any,
        ];
        const result = formatSitesCompact(sites);

        expect(result).toContain('Test Site');
        expect(result).toContain('`testsite`');
        expect(result).toContain('N/A');
      });

      it('should format site with undefined audience', () => {
        const sites = [
          {
            name: 'Test Site',
            api_site_parameter: 'testsite',
            audience: undefined,
          } as any,
        ];
        const result = formatSitesCompact(sites);

        expect(result).toContain('N/A');
      });

      it('should format site with unicode name', () => {
        const sites = [
          {
            name: '日本語 サイト',
            api_site_parameter: 'japanese-site',
            audience: 'Japanese users',
          } as any,
        ];
        const result = formatSitesCompact(sites);

        expect(result).toContain('日本語 サイト');
      });

      it('should format site with emoji in name', () => {
        const sites = [
          {
            name: '🎉 Fun Site',
            api_site_parameter: 'fun-site',
            audience: 'Fun people',
          } as any,
        ];
        const result = formatSitesCompact(sites);

        expect(result).toContain('🎉 Fun Site');
      });
    });

    describe('negative cases', () => {
      it('should handle undefined name', () => {
        const sites = [
          {
            name: undefined,
            api_site_parameter: 'test',
            audience: 'Test audience',
          } as any,
        ];
        const result = formatSitesCompact(sites);

        expect(result).toContain('1.');
        expect(result).toContain('`test`');
      });

      it('should handle undefined api_site_parameter', () => {
        const sites = [
          {
            name: 'Test Site',
            api_site_parameter: undefined,
            audience: 'Test audience',
          } as any,
        ];
        const result = formatSitesCompact(sites);

        expect(result).toContain('Test Site');
        expect(result).toContain('`undefined`'); // Backticks around undefined string
      });
    });

    describe('edge cases', () => {
      it('should format site with very long name', () => {
        const longName = 'A'.repeat(1000);
        const sites = [
          {
            name: longName,
            api_site_parameter: 'test',
            audience: 'Test',
          } as any,
        ];
        const result = formatSitesCompact(sites);

        expect(result).toContain(longName);
      });

      it('should format site with very long audience', () => {
        const longAudience = 'A'.repeat(1000);
        const sites = [
          {
            name: 'Test Site',
            api_site_parameter: 'test',
            audience: longAudience,
          } as any,
        ];
        const result = formatSitesCompact(sites);

        expect(result).toContain(longAudience);
      });

      it('should format site with special characters in name', () => {
        const sites = [
          {
            name: 'Site with <special> & "characters"',
            api_site_parameter: 'test',
            audience: 'Test',
          } as any,
        ];
        const result = formatSitesCompact(sites);

        expect(result).toContain('Site with <special> & "characters"');
      });
    });
  });
});
