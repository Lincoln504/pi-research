/**
 * Stack Exchange JSON Output Formatter Unit Tests
 *
 * Tests pure functions for formatting results in JSON format.
 * No external dependencies required.
 */

import { describe, it, expect } from 'vitest';
import {
  formatQuestionsJSON,
  formatAnswersJSON,
  formatUsersJSON,
  formatSitesJSON,
} from '../../../../src/stackexchange/output/json';

describe('stackexchange/output/json', () => {
  describe('formatQuestionsJSON', () => {
    it('should format empty questions list', () => {
      const result = formatQuestionsJSON([]);
      expect(result).toBe('[]');
    });

    it('should format single question', () => {
      const questions = [{
        title: 'Test question',
        link: 'https://stackoverflow.com/q/123',
        score: 10,
        answer_count: 5,
        view_count: 100,
        accepted_answer_id: 456,
      }] as any;

      const result = formatQuestionsJSON(questions);
      const parsed = JSON.parse(result);

      expect(parsed).toEqual(questions);
    });

    it('should format multiple questions', () => {
      const questions = [
        { title: 'First', link: 'https://stackoverflow.com/q/1', score: 10, answer_count: 5, view_count: 100, accepted_answer_id: 1 },
        { title: 'Second', link: 'https://stackoverflow.com/q/2', score: 20, answer_count: 10, view_count: 200, accepted_answer_id: 2 },
      ] as any;

      const result = formatQuestionsJSON(questions);
      const parsed = JSON.parse(result);

      expect(parsed).toEqual(questions);
      expect(parsed).toHaveLength(2);
    });

    it('should use 2-space indentation', () => {
      const questions = [{
        title: 'Test',
        link: 'https://stackoverflow.com/q/123',
        score: 10,
        answer_count: 5,
        view_count: 100,
        accepted_answer_id: 456,
      }] as any;

      const result = formatQuestionsJSON(questions);

      expect(result).toContain('  '); // 2-space indentation
      expect(result).toContain('    \"title\":'); // 4 spaces (2 for array + 2 for object)
    });
  });

  describe('formatAnswersJSON', () => {
    it('should format empty answers list', () => {
      const result = formatAnswersJSON([]);
      expect(result).toBe('[]');
    });

    it('should format single answer', () => {
      const answers = [{
        is_accepted: true,
        score: 15,
        question_id: 123,
        owner: { display_name: 'TestUser', reputation: 1000 },
      }] as any;

      const result = formatAnswersJSON(answers);
      const parsed = JSON.parse(result);

      expect(parsed).toEqual(answers);
    });

    it('should format multiple answers', () => {
      const answers = [
        { is_accepted: true, score: 15, question_id: 123, owner: { display_name: 'User1', reputation: 1000 } },
        { is_accepted: false, score: 5, question_id: 123, owner: { display_name: 'User2', reputation: 500 } },
      ] as any;

      const result = formatAnswersJSON(answers);
      const parsed = JSON.parse(result);

      expect(parsed).toHaveLength(2);
      expect(parsed[0].is_accepted).toBe(true);
      expect(parsed[1].is_accepted).toBe(false);
    });

    it('should use 2-space indentation', () => {
      const answers = [{
        is_accepted: true,
        score: 15,
        question_id: 123,
        owner: { display_name: 'TestUser', reputation: 1000 },
      }] as any;

      const result = formatAnswersJSON(answers);

      expect(result).toContain('  '); // 2-space indentation
    });
  });

  describe('formatUsersJSON', () => {
    it('should format empty users list', () => {
      const result = formatUsersJSON([]);
      expect(result).toBe('[]');
    });

    it('should format single user', () => {
      const users = [{
        display_name: 'TestUser',
        reputation: 1000,
        badge_counts: { gold: 5, silver: 10, bronze: 20 },
        user_id: 123,
        link: 'https://stackoverflow.com/users/123',
      }] as any;

      const result = formatUsersJSON(users);
      const parsed = JSON.parse(result);

      expect(parsed).toEqual(users);
    });

    it('should format multiple users', () => {
      const users = [
        { display_name: 'User1', reputation: 1000, badge_counts: { gold: 5, silver: 10, bronze: 20 }, user_id: 1 },
        { display_name: 'User2', reputation: 2000, badge_counts: { gold: 10, silver: 20, bronze: 30 }, user_id: 2 },
      ] as any;

      const result = formatUsersJSON(users);
      const parsed = JSON.parse(result);

      expect(parsed).toHaveLength(2);
    });

    it('should use 2-space indentation', () => {
      const users = [{
        display_name: 'TestUser',
        reputation: 1000,
        badge_counts: { gold: 5, silver: 10, bronze: 20 },
        user_id: 123,
      }] as any;

      const result = formatUsersJSON(users);

      expect(result).toContain('  '); // 2-space indentation
    });
  });

  describe('formatSitesJSON', () => {
    it('should format empty sites list', () => {
      const result = formatSitesJSON([]);
      expect(result).toBe('[]');
    });

    it('should format single site', () => {
      const sites = [{
        name: 'Stack Overflow',
        api_site_parameter: 'stackoverflow',
        audience: 'Professional and enthusiast programmers',
      }] as any;

      const result = formatSitesJSON(sites);
      const parsed = JSON.parse(result);

      expect(parsed).toEqual(sites);
    });

    it('should format multiple sites', () => {
      const sites = [
        { name: 'Stack Overflow', api_site_parameter: 'stackoverflow', audience: 'Programmers' },
        { name: 'Super User', api_site_parameter: 'superuser', audience: 'Enthusiasts' },
      ] as any;

      const result = formatSitesJSON(sites);
      const parsed = JSON.parse(result);

      expect(parsed).toHaveLength(2);
    });

    it('should use 2-space indentation', () => {
      const sites = [{
        name: 'Stack Overflow',
        api_site_parameter: 'stackoverflow',
        audience: 'Programmers',
      }] as any;

      const result = formatSitesJSON(sites);

      expect(result).toContain('  '); // 2-space indentation
    });
  });

  describe('integration scenarios', () => {
    it('should maintain consistent formatting across all functions', () => {
      const data = [{ test: 'value' }] as any;

      const questionsResult = formatQuestionsJSON(data);
      const answersResult = formatAnswersJSON(data);
      const usersResult = formatUsersJSON(data);
      const sitesResult = formatSitesJSON(data);

      // All should use 2-space indentation
      expect(questionsResult).toContain('  \"test\"');
      expect(answersResult).toContain('  \"test\"');
      expect(usersResult).toContain('  \"test\"');
      expect(sitesResult).toContain('  \"test\"');
    });

    it('should handle arrays with complex nested data', () => {
      const complexData = [{
        simple: 'value',
        number: 123,
        boolean: true,
        nullValue: null,
        array: [1, 2, 3],
        object: { nested: 'data' },
      }] as any;

      const result = formatQuestionsJSON(complexData);
      const parsed = JSON.parse(result);

      expect(parsed[0].simple).toBe('value');
      expect(parsed[0].number).toBe(123);
      expect(parsed[0].boolean).toBe(true);
      expect(parsed[0].nullValue).toBe(null);
      expect(parsed[0].array).toEqual([1, 2, 3]);
      expect(parsed[0].object.nested).toBe('data');
    });
  });
});
