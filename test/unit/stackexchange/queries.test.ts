/**
 * Stack Exchange Queries Unit Tests
 *
 * Tests pure query building functions without mocking.
 * All functions are pure and testable without external dependencies.
 */

import { describe, it, expect } from 'vitest';
import {
  buildSearchParams,
  buildSearchQuery,
  buildQuestionsQuery,
  buildUserQuery,
  buildSitesQuery,
} from '../../../src/stackexchange/queries';

describe('stackexchange queries', () => {
  describe('buildSearchParams', () => {
    describe('positive cases - valid parameters', () => {
      it('should build empty params', () => {
        const params = buildSearchParams({});
        expect(params.toString()).toBe('');
      });

      it('should build string params', () => {
        const params = buildSearchParams({
          query: 'test query',
          site: 'stackoverflow.com',
          intitle: 'typescript',
        });
        expect(params.get('query')).toBe('test query');
        expect(params.get('site')).toBe('stackoverflow.com');
        expect(params.get('intitle')).toBe('typescript');
      });

      it('should build boolean params (true)', () => {
        const params = buildSearchParams({
          accepted: true,
          wiki: true,
          closed: true,
        });
        expect(params.get('accepted')).toBe('true');
        expect(params.get('wiki')).toBe('true');
        expect(params.get('closed')).toBe('true');
      });

      it('should build boolean params (false)', () => {
        const params = buildSearchParams({
          accepted: false,
          wiki: false,
          closed: false,
        });
        expect(params.get('accepted')).toBe('false');
        expect(params.get('wiki')).toBe('false');
        expect(params.get('closed')).toBe('false');
      });

      it('should build number params', () => {
        const params = buildSearchParams({
          page: 2,
          pagesize: 50,
          answers: 3,
          views: 1000,
        });
        expect(params.get('page')).toBe('2');
        expect(params.get('pagesize')).toBe('50');
        expect(params.get('answers')).toBe('3');
        expect(params.get('views')).toBe('1000');
      });

      it('should build array params (tags)', () => {
        const params = buildSearchParams({
          tagged: ['typescript', 'javascript', 'react'],
        });
        expect(params.get('tagged')).toBe('typescript;javascript;react');
      });

      it('should build array params (notagged)', () => {
        const params = buildSearchParams({
          nottagged: ['java', 'python'],
        });
        expect(params.get('nottagged')).toBe('java;python');
      });

      it('should build user ID param', () => {
        const params = buildSearchParams({
          user: 12345,
        });
        expect(params.get('user')).toBe('12345');
      });

      it('should build URL param', () => {
        const params = buildSearchParams({
          url: 'https://example.com',
        });
        expect(params.get('url')).toBe('https://example.com');
      });

      it('should build all parameter types together', () => {
        const params = buildSearchParams({
          query: 'test',
          tagged: ['ts', 'js'],
          accepted: true,
          answers: 2,
          page: 1,
          pagesize: 25,
          site: 'stackoverflow.com',
        });
        expect(params.get('query')).toBe('test');
        expect(params.get('tagged')).toBe('ts;js');
        expect(params.get('accepted')).toBe('true');
        expect(params.get('answers')).toBe('2');
        expect(params.get('page')).toBe('1');
        expect(params.get('pagesize')).toBe('25');
        expect(params.get('site')).toBe('stackoverflow.com');
      });

      it('should handle special characters in strings', () => {
        const params = buildSearchParams({
          query: 'test "quoted" & special',
          title: 'C# & .NET',
        });
        expect(params.get('query')).toBe('test "quoted" & special');
        expect(params.get('title')).toBe('C# & .NET');
      });

      it('should handle unicode characters', () => {
        const params = buildSearchParams({
          query: '日本語 тест العربية',
        });
        expect(params.get('query')).toBe('日本語 тест العربية');
      });

      it('should handle very long strings', () => {
        const longString = 'a'.repeat(1000);
        const params = buildSearchParams({
          query: longString,
        });
        expect(params.get('query')).toBe(longString);
      });
    });

    describe('negative cases - filtering invalid values', () => {
      it('should ignore undefined params', () => {
        const params = buildSearchParams({
          query: 'test',
          page: undefined,
          pagesize: undefined,
        });
        expect(params.get('query')).toBe('test');
        expect(params.get('page')).toBeNull();
        expect(params.get('pagesize')).toBeNull();
      });

      it('should ignore null params', () => {
        const params = buildSearchParams({
          query: 'test',
          page: null,
          pagesize: null,
        } as any);
        expect(params.get('query')).toBe('test');
        expect(params.get('page')).toBeNull();
        expect(params.get('pagesize')).toBeNull();
      });

      it('should handle zero values', () => {
        const params = buildSearchParams({
          page: 0,
          answers: 0,
          views: 0,
        });
        expect(params.get('page')).toBe('0');
        expect(params.get('answers')).toBe('0');
        expect(params.get('views')).toBe('0');
      });

      it('should handle negative numbers', () => {
        const params = buildSearchParams({
          page: -1,
          answers: -1,
        });
        expect(params.get('page')).toBe('-1');
        expect(params.get('answers')).toBe('-1');
      });

      it('should handle empty string arrays', () => {
        const params = buildSearchParams({
          tagged: [],
        });
        expect(params.get('tagged')).toBe('');
      });

      it('should handle single-element arrays', () => {
        const params = buildSearchParams({
          tagged: ['typescript'],
        });
        expect(params.get('tagged')).toBe('typescript');
      });
    });

    describe('edge cases', () => {
      it('should handle very large numbers', () => {
        const params = buildSearchParams({
          views: 999999999999,
        });
        expect(params.get('views')).toBe('999999999999');
      });

      it('should handle floating point numbers', () => {
        const params = buildSearchParams({
          page: 2.5,
          views: 1000.75,
        });
        expect(params.get('page')).toBe('2.5');
        expect(params.get('views')).toBe('1000.75');
      });

      it('should handle arrays with special characters', () => {
        const params = buildSearchParams({
          tagged: ['c++', 'c#', '.net'],
        });
        expect(params.get('tagged')).toBe('c++;c#;.net');
      });

      it('should handle empty object', () => {
        const params = buildSearchParams({});
        expect(params.toString()).toBe('');
      });

      it('should preserve parameter order (as expected by URLSearchParams)', () => {
        const params = buildSearchParams({
          page: 1,
          pagesize: 50,
          sort: 'activity',
          order: 'desc',
        });
        const str = params.toString();
        expect(str).toContain('page=1');
        expect(str).toContain('pagesize=50');
        expect(str).toContain('sort=activity');
        expect(str).toContain('order=desc');
      });
    });
  });

  describe('buildSearchQuery', () => {
    it('should alias buildSearchParams', () => {
      const result = buildSearchQuery({
        query: 'test',
        tagged: ['typescript'],
      });
      expect(result.get('query')).toBe('test');
      expect(result.get('tagged')).toBe('typescript');
    });

    it('should handle all search params', () => {
      const result = buildSearchQuery({
        query: 'typescript async',
        title: 'async await',
        tagged: ['typescript', 'javascript'],
        nottagged: ['java'],
        accepted: true,
        answers: 5,
        page: 2,
        pagesize: 25,
        sort: 'activity',
        order: 'desc',
        site: 'stackoverflow.com',
      });
      expect(result.get('query')).toBe('typescript async');
      expect(result.get('title')).toBe('async await');
      expect(result.get('tagged')).toBe('typescript;javascript');
      expect(result.get('nottagged')).toBe('java');
      expect(result.get('accepted')).toBe('true');
      expect(result.get('answers')).toBe('5');
      expect(result.get('page')).toBe('2');
      expect(result.get('pagesize')).toBe('25');
      expect(result.get('sort')).toBe('activity');
      expect(result.get('order')).toBe('desc');
      expect(result.get('site')).toBe('stackoverflow.com');
    });
  });

  describe('buildQuestionsQuery', () => {
    describe('positive cases - valid parameters', () => {
      it('should build with single ID (string)', () => {
        const params = buildQuestionsQuery({
          ids: '12345',
        });
        expect(params.get('order')).toBe('desc');
        expect(params.get('sort')).toBe('activity');
        expect(params.get('site')).toBe('stackoverflow.com');
      });

      it('should build with single ID (number)', () => {
        const params = buildQuestionsQuery({
          ids: 12345,
        });
        expect(params.get('order')).toBe('desc');
        expect(params.get('sort')).toBe('activity');
        expect(params.get('site')).toBe('stackoverflow.com');
      });

      it('should build with multiple IDs (strings)', () => {
        const params = buildQuestionsQuery({
          ids: ['12345', '67890', '54321'],
        });
        expect(params.get('order')).toBe('desc');
        expect(params.get('sort')).toBe('activity');
        expect(params.get('site')).toBe('stackoverflow.com');
      });

      it('should build with multiple IDs (numbers)', () => {
        const params = buildQuestionsQuery({
          ids: [12345, 67890, 54321],
        });
        expect(params.get('order')).toBe('desc');
        expect(params.get('sort')).toBe('activity');
        expect(params.get('site')).toBe('stackoverflow.com');
      });

      it('should build with mixed ID types', () => {
        const params = buildQuestionsQuery({
          ids: [12345, '67890', 54321],
        });
        expect(params.get('order')).toBe('desc');
        expect(params.get('sort')).toBe('activity');
        expect(params.get('site')).toBe('stackoverflow.com');
      });

      it('should build with custom sort options', () => {
        const params = buildQuestionsQuery({
          ids: '12345',
          sort: 'creation',
          order: 'asc',
        });
        expect(params.get('sort')).toBe('creation');
        expect(params.get('order')).toBe('asc');
      });

      it('should build with pagination', () => {
        const params = buildQuestionsQuery({
          ids: '12345',
          page: 3,
          pagesize: 100,
        });
        expect(params.get('page')).toBe('3');
        expect(params.get('pagesize')).toBe('100');
      });

      it('should build with custom site', () => {
        const params = buildQuestionsQuery({
          ids: '12345',
          site: 'serverfault.com',
        });
        expect(params.get('site')).toBe('serverfault.com');
      });

      it('should build with filter', () => {
        const params = buildQuestionsQuery({
          ids: '12345',
          filter: 'withbody',
        });
        expect(params.get('filter')).toBe('withbody');
      });

      it('should build with all options', () => {
        const params = buildQuestionsQuery({
          ids: ['12345', '67890'],
          site: 'superuser.com',
          filter: 'withbody',
          sort: 'votes',
          order: 'desc',
          page: 2,
          pagesize: 50,
        });
        expect(params.get('site')).toBe('superuser.com');
        expect(params.get('filter')).toBe('withbody');
        expect(params.get('sort')).toBe('votes');
        expect(params.get('order')).toBe('desc');
        expect(params.get('page')).toBe('2');
        expect(params.get('pagesize')).toBe('50');
      });
    });

    describe('edge cases', () => {
      it('should handle empty ID array', () => {
        const params = buildQuestionsQuery({
          ids: [],
        });
        expect(params.get('order')).toBe('desc');
        expect(params.get('sort')).toBe('activity');
        expect(params.get('site')).toBe('stackoverflow.com');
      });

      it('should handle very large ID', () => {
        const params = buildQuestionsQuery({
          ids: 999999999999,
        });
        expect(params.get('order')).toBe('desc');
        expect(params.get('sort')).toBe('activity');
        expect(params.get('site')).toBe('stackoverflow.com');
      });

      it('should handle very large pagesize', () => {
        const params = buildQuestionsQuery({
          ids: '12345',
          pagesize: 10000,
        });
        expect(params.get('pagesize')).toBe('10000');
      });
    });
  });

  describe('buildUserQuery', () => {
    describe('positive cases - valid parameters', () => {
      it('should build with single ID', () => {
        const params = buildUserQuery({
          ids: '12345',
        });
        expect(params.get('site')).toBe('stackoverflow.com');
      });

      it('should build with multiple IDs', () => {
        const params = buildUserQuery({
          ids: [12345, 67890, 54321],
        });
        expect(params.get('site')).toBe('stackoverflow.com');
      });

      it('should build with reputation sort', () => {
        const params = buildUserQuery({
          ids: '12345',
          sort: 'reputation',
          order: 'desc',
        });
        expect(params.get('sort')).toBe('reputation');
        expect(params.get('order')).toBe('desc');
      });

      it('should build with custom site', () => {
        const params = buildUserQuery({
          ids: '12345',
          site: 'mathoverflow.net',
        });
        expect(params.get('site')).toBe('mathoverflow.net');
      });

      it('should build with pagination', () => {
        const params = buildUserQuery({
          ids: '12345',
          page: 5,
          pagesize: 20,
        });
        expect(params.get('page')).toBe('5');
        expect(params.get('pagesize')).toBe('20');
      });
    });

    describe('edge cases', () => {
      it('should handle empty ID array', () => {
        const params = buildUserQuery({
          ids: [],
        });
        expect(params.get('site')).toBe('stackoverflow.com');
      });

      it('should handle ID 0', () => {
        const params = buildUserQuery({
          ids: 0,
        });
        expect(params.get('site')).toBe('stackoverflow.com');
      });
    });
  });

  describe('buildSitesQuery', () => {
    describe('positive cases - valid parameters', () => {
      it('should build without parameters', () => {
        const params = buildSitesQuery({});
        expect(params.toString()).toBe('');
      });

      it('should build with page', () => {
        const params = buildSitesQuery({
          page: 2,
        });
        expect(params.get('page')).toBe('2');
      });

      it('should build with pagesize', () => {
        const params = buildSitesQuery({
          pagesize: 100,
        });
        expect(params.get('pagesize')).toBe('100');
      });

      it('should build with both page and pagesize', () => {
        const params = buildSitesQuery({
          page: 3,
          pagesize: 50,
        });
        expect(params.get('page')).toBe('3');
        expect(params.get('pagesize')).toBe('50');
      });
    });

    describe('edge cases', () => {
      it('should not set page when 0 (falsy value)', () => {
        const params = buildSitesQuery({
          page: 0,
        });
        // 0 is falsy in JS, so it won't be set by `if (params?.page)`
        expect(params.get('page')).toBeNull();
      });

      it('should handle very large page', () => {
        const params = buildSitesQuery({
          page: 99999,
        });
        expect(params.get('page')).toBe('99999');
      });

      it('should handle very large pagesize', () => {
        const params = buildSitesQuery({
          pagesize: 10000,
        });
        expect(params.get('pagesize')).toBe('10000');
      });
    });
  });

  describe('integration - URL string generation', () => {
    it('should generate valid URL string for search', () => {
      const params = buildSearchParams({
        query: 'typescript',
        tagged: ['ts'],
        page: 1,
      });
      const url = params.toString();
      expect(url).toContain('query=typescript');
      expect(url).toContain('tagged=ts');
      expect(url).toContain('page=1');
    });

    it('should encode special characters in URL', () => {
      const params = buildSearchParams({
        query: 'C# & .NET',
      });
      const url = params.toString();
      expect(url).toContain('C%23');
      expect(url).toContain('.NET');
    });

    it('should handle multiple parameters with proper separators', () => {
      const params = buildSearchParams({
        query: 'test',
        page: 1,
        pagesize: 25,
        sort: 'activity',
      });
      const url = params.toString();
      const parts = url.split('&');
      expect(parts).toHaveLength(4);
      expect(parts).toContainEqual(expect.stringContaining('query=test'));
      expect(parts).toContainEqual(expect.stringContaining('page=1'));
      expect(parts).toContainEqual(expect.stringContaining('pagesize=25'));
      expect(parts).toContainEqual(expect.stringContaining('sort=activity'));
    });
  });
});
