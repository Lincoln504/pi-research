/**
 * Stack Exchange Table Output Formatter Unit Tests
 *
 * Tests pure functions for formatting results in table format.
 * No external dependencies required.
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

    it('should format single question', () => {
      const questions = [{
        title: 'Test question',
        link: 'https://stackoverflow.com/q/123',
        score: 10,
        answer_count: 5,
        view_count: 100,
        accepted_answer_id: 456,
        creation_date: 1609459200,
        tags: ['javascript'],
        owner: { display_name: 'TestUser', reputation: 1000 },
      }] as any;

      const result = formatQuestionsTable(questions);
      expect(result).toContain('# Stack Exchange Questions');
      expect(result).toContain('## Test question');
      expect(result).toContain('**Score:** 10');
      expect(result).toContain('**Answers:** 5 ✓');
    });

    it('should format question without accepted answer', () => {
      const questions = [{
        title: 'Unanswered',
        link: 'https://stackoverflow.com/q/123',
        score: 5,
        answer_count: 2,
        view_count: 50,
        accepted_answer_id: null,
        creation_date: 1609459200,
        tags: [],
      }] as any;

      const result = formatQuestionsTable(questions);
      expect(result).toContain('**Answers:** 2');
      expect(result).not.toContain('✓');
    });

    it('should format multiple questions', () => {
      const questions = [
        {
          title: 'First',
          link: 'https://stackoverflow.com/q/1',
          score: 10,
          answer_count: 5,
          view_count: 100,
          accepted_answer_id: 1,
          creation_date: 1609459200,
          tags: [],
        },
        {
          title: 'Second',
          link: 'https://stackoverflow.com/q/2',
          score: 20,
          answer_count: 10,
          view_count: 200,
          accepted_answer_id: 2,
          creation_date: 1609459200,
          tags: [],
        },
      ] as any;

      const result = formatQuestionsTable(questions);
      expect(result).toContain('Found: 2 questions');
      expect(result).toContain('## First');
      expect(result).toContain('## Second');
    });

    it('should include body when short enough', () => {
      const questions = [{
        title: 'Question with body',
        link: 'https://stackoverflow.com/q/123',
        score: 10,
        answer_count: 5,
        view_count: 100,
        accepted_answer_id: 456,
        creation_date: 1609459200,
        tags: [],
        body: 'Short body',
      }] as any;

      const result = formatQuestionsTable(questions);
      expect(result).toContain('**Body:** Short body');
    });

    it('should not include body when too long', () => {
      const questions = [{
        title: 'Long body',
        link: 'https://stackoverflow.com/q/123',
        score: 10,
        answer_count: 5,
        view_count: 100,
        accepted_answer_id: 456,
        creation_date: 1609459200,
        tags: [],
        body: 'A'.repeat(1001),
      }] as any;

      const result = formatQuestionsTable(questions);
      expect(result).not.toContain('**Body:**');
    });

    it('should handle question without owner', () => {
      const questions = [{
        title: 'Orphan',
        link: 'https://stackoverflow.com/q/123',
        score: 5,
        answer_count: 2,
        view_count: 50,
        accepted_answer_id: 456,
        creation_date: 1609459200,
        tags: [],
        owner: null,
      }] as any;

      const result = formatQuestionsTable(questions);
      expect(result).not.toContain('**Author:**');
    });

    it('should handle negative score', () => {
      const questions = [{
        title: 'Downvoted',
        link: 'https://stackoverflow.com/q/123',
        score: -5,
        answer_count: 2,
        view_count: 10,
        accepted_answer_id: 456,
        creation_date: 1609459200,
        tags: [],
      }] as any;

      const result = formatQuestionsTable(questions);
      expect(result).toContain('**Score:** -5');
    });

    it('should handle unicode in title', () => {
      const questions = [{
        title: 'Question 日本語 🎉',
        link: 'https://stackoverflow.com/q/123',
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

    it('should format single accepted answer', () => {
      const answers = [{
        is_accepted: true,
        score: 15,
        question_id: 123,
        creation_date: 1609459200,
        owner: { display_name: 'TestUser', reputation: 1000 },
      }] as any;

      const result = formatAnswersTable(answers);
      expect(result).toContain('## Answer by TestUser');
      expect(result).toContain('**Score:** 15 ✓ (Accepted)');
    });

    it('should format non-accepted answer', () => {
      const answers = [{
        is_accepted: false,
        score: 10,
        question_id: 123,
        creation_date: 1609459200,
        owner: { display_name: 'TestUser', reputation: 1000 },
      }] as any;

      const result = formatAnswersTable(answers);
      expect(result).toContain('**Score:** 10');
      expect(result).not.toContain('✓ (Accepted)');
    });

    it('should include body when present and short', () => {
      const answers = [{
        is_accepted: true,
        score: 10,
        question_id: 123,
        creation_date: 1609459200,
        owner: { display_name: 'TestUser' },
        body: 'Short answer body',
      }] as any;

      const result = formatAnswersTable(answers);
      expect(result).toContain('### Answer Body');
      expect(result).toContain('Short answer body');
    });

    it('should not include body when too long', () => {
      const answers = [{
        is_accepted: true,
        score: 10,
        question_id: 123,
        creation_date: 1609459200,
        owner: { display_name: 'TestUser' },
        body: 'A'.repeat(2001),
      }] as any;

      const result = formatAnswersTable(answers);
      expect(result).not.toContain('### Answer Body');
    });

    it('should handle answer without owner', () => {
      const answers = [{
        is_accepted: true,
        score: 10,
        question_id: 123,
        creation_date: 1609459200,
        owner: undefined,
      }] as any;

      const result = formatAnswersTable(answers);
      expect(result).toContain('## Answer by Unknown');
      expect(result).not.toContain('**Author:**');
    });

    it('should handle negative score', () => {
      const answers = [{
        is_accepted: false,
        score: -5,
        question_id: 123,
        creation_date: 1609459200,
        owner: { display_name: 'Downvoted' },
      }] as any;

      const result = formatAnswersTable(answers);
      expect(result).toContain('**Score:** -5');
    });

    it('should handle zero score', () => {
      const answers = [{
        is_accepted: true,
        score: 0,
        question_id: 123,
        creation_date: 1609459200,
        owner: { display_name: 'Neutral' },
      }] as any;

      const result = formatAnswersTable(answers);
      expect(result).toContain('**Score:** 0 ✓ (Accepted)');
    });

    it('should format multiple answers', () => {
      const answers = [
        { is_accepted: true, score: 15, question_id: 123, creation_date: 1609459200, owner: { display_name: 'User1' } },
        { is_accepted: false, score: 5, question_id: 123, creation_date: 1609459200, owner: { display_name: 'User2' } },
      ] as any;

      const result = formatAnswersTable(answers);
      expect(result).toContain('Found: 2 answers');
      expect(result).toContain('## Answer by User1');
      expect(result).toContain('## Answer by User2');
    });
  });

  describe('formatUsersTable', () => {
    it('should format empty users list', () => {
      const result = formatUsersTable([]);
      expect(result).toBe('No users found.\n');
    });

    it('should format single user', () => {
      const users = [{
        display_name: 'TestUser',
        reputation: 1000,
        badge_counts: { gold: 5, silver: 10, bronze: 20 },
        user_id: 123,
        creation_date: 1609459200,
        location: 'San Francisco',
        website_url: 'https://example.com',
        link: 'https://stackoverflow.com/users/123',
      }] as any;

      const result = formatUsersTable(users);
      expect(result).toContain('## TestUser');
      expect(result).toContain('**Reputation:** 1000');
      expect(result).toContain('**Badges:** 🥇 5 🥈 10 🥉 20');
      expect(result).toContain('**Location:** San Francisco');
      expect(result).toContain('**Website:** https://example.com');
    });

    it('should handle user without optional fields', () => {
      const users = [{
        display_name: 'MinimalUser',
        reputation: 100,
        badge_counts: { gold: 0, silver: 0, bronze: 0 },
        user_id: 1,
        creation_date: 1609459200,
        location: undefined,
        website_url: undefined,
        link: 'https://stackoverflow.com/users/1',
      }] as any;

      const result = formatUsersTable(users);
      expect(result).toContain('## MinimalUser');
      expect(result).not.toContain('**Location:**');
      expect(result).not.toContain('**Website:**');
    });

    it('should handle negative reputation', () => {
      const users = [{
        display_name: 'DownvotedUser',
        reputation: -10,
        badge_counts: { gold: 0, silver: 0, bronze: 0 },
        user_id: 123,
        creation_date: 1609459200,
        link: 'https://stackoverflow.com/users/123',
      }] as any;

      const result = formatUsersTable(users);
      expect(result).toContain('**Reputation:** -10');
    });

    it('should handle unicode display name', () => {
      const users = [{
        display_name: '日本語 User',
        reputation: 1000,
        badge_counts: { gold: 5, silver: 10, bronze: 20 },
        user_id: 123,
        creation_date: 1609459200,
        link: 'https://stackoverflow.com/users/123',
      }] as any;

      const result = formatUsersTable(users);
      expect(result).toContain('## 日本語 User');
    });

    it('should format multiple users', () => {
      const users = [
        { display_name: 'User1', reputation: 1000, badge_counts: { gold: 5, silver: 10, bronze: 20 }, user_id: 1, creation_date: 1609459200, link: 'https://stackoverflow.com/users/1' },
        { display_name: 'User2', reputation: 2000, badge_counts: { gold: 10, silver: 20, bronze: 30 }, user_id: 2, creation_date: 1609459200, link: 'https://stackoverflow.com/users/2' },
      ] as any;

      const result = formatUsersTable(users);
      expect(result).toContain('Found: 2 users');
      expect(result).toContain('## User1');
      expect(result).toContain('## User2');
    });
  });

  describe('formatSitesTable', () => {
    it('should format empty sites list', () => {
      const result = formatSitesTable([]);
      expect(result).toBe('No sites found.\n');
    });

    it('should format single site', () => {
      const sites = [{
        name: 'Stack Overflow',
        api_site_parameter: 'stackoverflow',
        audience: 'Professional and enthusiast programmers',
      }] as any;

      const result = formatSitesTable(sites);
      expect(result).toContain('# Stack Exchange Sites');
      expect(result).toContain('| Stack Overflow | `stackoverflow` | Professional and enthusiast programmers |');
    });

    it('should format site without audience', () => {
      const sites = [{
        name: 'Test Site',
        api_site_parameter: 'testsite',
        audience: null,
      }] as any;

      const result = formatSitesTable(sites);
      expect(result).toContain('| Test Site | `testsite` | N/A |');
    });

    it('should format multiple sites', () => {
      const sites = [
        { name: 'Stack Overflow', api_site_parameter: 'stackoverflow', audience: 'Programmers' },
        { name: 'Super User', api_site_parameter: 'superuser', audience: 'Enthusiasts' },
      ] as any;

      const result = formatSitesTable(sites);
      expect(result).toContain('Found: 2 sites');
      expect(result).toContain('| Stack Overflow |');
      expect(result).toContain('| Super User |');
    });

    it('should handle site with undefined api_site_parameter', () => {
      const sites = [{
        name: 'Test Site',
        api_site_parameter: undefined,
        audience: 'Test',
      }] as any;

      const result = formatSitesTable(sites);
      expect(result).toContain('| Test Site | `undefined` | Test |');
    });

    it('should handle unicode in site name', () => {
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

    it('should format single question with accepted answer', () => {
      const questions = [{
        title: 'Test question',
        link: 'https://stackoverflow.com/q/123',
        score: 10,
        answer_count: 5,
        accepted_answer_id: 456,
      }] as any;

      const result = formatCompactQuestions(questions);
      expect(result).toContain('[Test question](https://stackoverflow.com/q/123) ✓');
      expect(result).toContain('(score: 10, answers: 5)');
    });

    it('should format question without accepted answer', () => {
      const questions = [{
        title: 'Unanswered',
        link: 'https://stackoverflow.com/q/123',
        score: 5,
        answer_count: 2,
        accepted_answer_id: null,
      }] as any;

      const result = formatCompactQuestions(questions);
      expect(result).toContain('  (score: 5, answers: 2)');
      expect(result).not.toContain('✓');
    });

    it('should format multiple questions', () => {
      const questions = [
        { title: 'First', link: 'https://stackoverflow.com/q/1', score: 10, answer_count: 5, accepted_answer_id: 1 },
        { title: 'Second', link: 'https://stackoverflow.com/q/2', score: 20, answer_count: 10, accepted_answer_id: 2 },
      ] as any;

      const result = formatCompactQuestions(questions);
      expect(result).toContain('1. [First]');
      expect(result).toContain('2. [Second]');
    });

    it('should handle negative score', () => {
      const questions = [{
        title: 'Downvoted',
        link: 'https://stackoverflow.com/q/123',
        score: -5,
        answer_count: 2,
        accepted_answer_id: 456,
      }] as any;

      const result = formatCompactQuestions(questions);
      expect(result).toContain('(score: -5');
    });

    it('should handle zero answers', () => {
      const questions = [{
        title: 'No answers',
        link: 'https://stackoverflow.com/q/123',
        score: 10,
        answer_count: 0,
        accepted_answer_id: null,
      }] as any;

      const result = formatCompactQuestions(questions);
      expect(result).toContain('answers: 0');
    });

    it('should handle unicode in title', () => {
      const questions = [{
        title: 'Question 日本語 🎉',
        link: 'https://stackoverflow.com/q/123',
        score: 10,
        answer_count: 5,
        accepted_answer_id: 456,
      }] as any;

      const result = formatCompactQuestions(questions);
      expect(result).toContain('[Question 日本語 🎉]');
    });
  });
});
