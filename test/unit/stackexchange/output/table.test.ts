/**
 * Stack Exchange Table Output Formatter Unit Tests
 *
 * Tests pure functions for formatting results in table format.
 * Tests focus on core functionality and edge cases, not every permutation.
 */

import { describe, it, expect } from 'vitest';
import {
  formatQuestionsTable,
  formatAnswersTable,
  formatUsersTable,
  formatSitesTable,
  formatCompactQuestions,
} from '../../../../src/stackexchange/output/table';

describe('stackexchange/output/table', () => {
  describe('formatQuestionsTable', () => {
    it('should format empty questions list', () => {
      const result = formatQuestionsTable([]);
      expect(result).toBe('No questions found.\n');
    });

    it('should format questions with and without accepted answers', () => {
      const questions = [
        {
          title: 'Question with accepted answer',
          link: 'https://stackoverflow.com/q/123',
          score: 10,
          answer_count: 5,
          view_count: 100,
          accepted_answer_id: 456,
          creation_date: 1609459200,
          tags: ['javascript'],
          owner: { display_name: 'TestUser', reputation: 1000 },
          body: 'Short body text',
        } as any,
        {
          title: 'Unanswered question',
          link: 'https://stackoverflow.com/q/124',
          score: 5,
          answer_count: 0,
          view_count: 50,
          accepted_answer_id: null,
          creation_date: 1609459200,
          tags: [],
          owner: null,
        } as any,
      ];

      const result = formatQuestionsTable(questions);
      expect(result).toContain('# Stack Exchange Questions');
      expect(result).toContain('Found: 2 questions');
      expect(result).toContain('## Question with accepted answer');
      expect(result).toContain('**Score:** 10');
      expect(result).toContain('**Answers:** 5 [accepted]');
      expect(result).toContain('**Body:** Short body text');
      expect(result).toContain('## Unanswered question');
      expect(result).toContain('**Score:** 5');
      expect(result).toContain('**Answers:** 0');
      // Unanswered has no [accepted] tag
    });

    it('should handle edge cases in question data', () => {
      const questions = [{
        title: 'Downvoted question',
        link: 'https://stackoverflow.com/q/125',
        score: -5,
        answer_count: 2,
        view_count: 10,
        accepted_answer_id: 456,
        creation_date: 1609459200,
        tags: [],
        body: 'A'.repeat(1001), // Too long body
      }] as any;

      const result = formatQuestionsTable(questions);
      expect(result).toContain('**Score:** -5');
      expect(result).not.toContain('**Body:**'); // Body too long to show
    });

    it('should handle unicode in question titles', () => {
      const questions = [{
        title: 'Question 日本語 🎉',
        link: 'https://stackoverflow.com/q/126',
        score: 10,
        answer_count: 5,
        view_count: 100,
        accepted_answer_id: 456,
        creation_date: 1609459200,
        tags: [],
      }] as any;

      const result = formatQuestionsTable(questions);
      expect(result).toContain('Question 日本語 🎉');
    });
  });

  describe('formatAnswersTable', () => {
    it('should format empty answers list', () => {
      const result = formatAnswersTable([]);
      expect(result).toBe('No answers found.\n');
    });

    it('should format answers with acceptance status and scores', () => {
      const answers = [
        {
          is_accepted: true,
          score: 15,
          question_id: 123,
          creation_date: 1609459200,
          owner: { display_name: 'ExpertUser', reputation: 1000 },
          body: 'Good answer',
        } as any,
        {
          is_accepted: false,
          score: 10,
          question_id: 123,
          creation_date: 1609459200,
          owner: { display_name: 'HelperUser', reputation: 500 },
        } as any,
        {
          is_accepted: false,
          score: -5,
          question_id: 123,
          creation_date: 1609459200,
          owner: { display_name: 'DownvotedUser', reputation: -10 },
        } as any,
      ];

      const result = formatAnswersTable(answers);
      expect(result).toContain('Found: 3 answers');
      expect(result).toContain('## Answer by ExpertUser');
      expect(result).toContain('**Score:** 15 [Accepted]');
      expect(result).toContain('### Answer Body');
      expect(result).toContain('Good answer');
      expect(result).toContain('## Answer by HelperUser');
      expect(result).toContain('**Score:** 10');
      expect(result).toContain('## Answer by DownvotedUser');
      expect(result).toContain('**Score:** -5');
    });

    it('should handle missing owner information', () => {
      const answers = [{
        is_accepted: true,
        score: 10,
        question_id: 123,
        creation_date: 1609459200,
        owner: undefined,
      }] as any;

      const result = formatAnswersTable(answers);
      expect(result).toContain('## Answer by Unknown');
      expect(result).toContain('**Score:** 10 [Accepted]');
    });

    it('should handle very long answer body', () => {
      const answers = [{
        is_accepted: true,
        score: 10,
        question_id: 123,
        creation_date: 1609459200,
        owner: { display_name: 'VerboseUser' },
        body: 'A'.repeat(2001), // Too long body
      }] as any;

      const result = formatAnswersTable(answers);
      expect(result).toContain('## Answer by VerboseUser');
      expect(result).not.toContain('### Answer Body'); // Body too long
    });
  });

  describe('formatUsersTable', () => {
    it('should format empty users list', () => {
      const result = formatUsersTable([]);
      expect(result).toBe('No users found.\n');
    });

    it('should format users with badges and optional fields', () => {
      const users = [
        {
          display_name: 'ExpertUser',
          reputation: 1000,
          badge_counts: { gold: 5, silver: 10, bronze: 20 },
          user_id: 123,
          creation_date: 1609459200,
          location: 'San Francisco',
          website_url: 'https://example.com',
          link: 'https://stackoverflow.com/users/123',
        } as any,
        {
          display_name: 'MinimalUser',
          reputation: 100,
          badge_counts: { gold: 0, silver: 0, bronze: 0 },
          user_id: 1,
          creation_date: 1609459200,
          location: undefined,
          website_url: undefined,
          link: 'https://stackoverflow.com/users/1',
        } as any,
        {
          display_name: 'NegativeRepUser',
          reputation: -10,
          badge_counts: { gold: 0, silver: 0, bronze: 0 },
          user_id: 2,
          creation_date: 1609459200,
          link: 'https://stackoverflow.com/users/2',
        } as any,
      ];

      const result = formatUsersTable(users);
      expect(result).toContain('Found: 3 users');
      expect(result).toContain('## ExpertUser');
      expect(result).toContain('**Reputation:** 1000');
      expect(result).toContain('**Badges:** gold:5 silver:10 bronze:20');
      expect(result).toContain('**Location:** San Francisco');
      expect(result).toContain('**Website:** https://example.com');
      
      expect(result).toContain('## MinimalUser');
      expect(result).toContain('**Reputation:** 100');
      expect(result).toContain('**Badges:** gold:0 silver:0 bronze:0');
      
      expect(result).toContain('## NegativeRepUser');
      expect(result).toContain('**Reputation:** -10');
    });

    it('should handle unicode in display names', () => {
      const users = [{
        display_name: '日本語 User 🎉',
        reputation: 1000,
        badge_counts: { gold: 5, silver: 10, bronze: 20 },
        user_id: 123,
        creation_date: 1609459200,
        link: 'https://stackoverflow.com/users/123',
      }] as any;

      const result = formatUsersTable(users);
      expect(result).toContain('## 日本語 User 🎉');
    });
  });

  describe('formatSitesTable', () => {
    it('should format empty sites list', () => {
      const result = formatSitesTable([]);
      expect(result).toBe('No sites found.\n');
    });

    it('should format sites with audience information', () => {
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

      const result = formatSitesTable(sites);
      expect(result).toContain('# Stack Exchange Sites');
      expect(result).toContain('Found: 3 sites');
      expect(result).toContain('| Stack Overflow | `stackoverflow` | Professional and enthusiast programmers |');
      expect(result).toContain('| Test Site | `testsite` | N/A |');
      expect(result).toContain('| Another Site | `another` | N/A |');
    });

    it('should handle missing api_site_parameter', () => {
      const sites = [{
        name: 'Test Site',
        api_site_parameter: undefined,
        audience: 'Test audience',
      }] as any;

      const result = formatSitesTable(sites);
      expect(result).toContain('| Test Site | `undefined` | Test audience |');
    });

    it('should handle unicode in site names', () => {
      const sites = [{
        name: '日本語 サイト',
        api_site_parameter: 'japanese',
        audience: 'Japanese',
      }] as any;

      const result = formatSitesTable(sites);
      expect(result).toContain('| 日本語 サイト | `japanese` | Japanese |');
    });
  });

  describe('formatCompactQuestions', () => {
    it('should format empty questions list', () => {
      const result = formatCompactQuestions([]);
      expect(result).toBe('No questions found.\n');
    });

    it('should format questions compactly with acceptance indicators', () => {
      const questions = [
        {
          title: 'Accepted question',
          link: 'https://stackoverflow.com/q/123',
          score: 10,
          answer_count: 5,
          accepted_answer_id: 456,
        } as any,
        {
          title: 'Unanswered question',
          link: 'https://stackoverflow.com/q/124',
          score: 5,
          answer_count: 0,
          accepted_answer_id: null,
        } as any,
        {
          title: 'Downvoted with answers',
          link: 'https://stackoverflow.com/q/125',
          score: -3,
          answer_count: 2,
          accepted_answer_id: null,
        } as any,
      ];

      const result = formatCompactQuestions(questions);
      expect(result).toContain('1. [Accepted question](https://stackoverflow.com/q/123) [accepted]');
      expect(result).toContain('(score: 10, answers: 5)');
      expect(result).toContain('2. [Unanswered question](https://stackoverflow.com/q/124)');
      expect(result).toContain('(score: 5, answers: 0)');
      expect(result).toContain('3. [Downvoted with answers](https://stackoverflow.com/q/125)');
      expect(result).toContain('(score: -3, answers: 2)');
    });

    it('should handle unicode in question titles', () => {
      const questions = [{
        title: 'Question 日本語 🎉',
        link: 'https://stackoverflow.com/q/126',
        score: 10,
        answer_count: 5,
        accepted_answer_id: 456,
      }] as any;

      const result = formatCompactQuestions(questions);
      expect(result).toContain('[Question 日本語 🎉]');
    });
  });
});