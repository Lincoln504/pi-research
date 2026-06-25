/**
 * Unit tests for YouTube video-ID extraction (pure, no I/O).
 */

import { describe, it, expect } from 'vitest';
import { extractVideoId, isYoutubeUrl, selectVideoIds, watchUrl } from '../../../src/youtube/video-id.ts';

describe('youtube/video-id', () => {
  describe('extractVideoId', () => {
    it('accepts a bare 11-char video ID', () => {
      expect(extractVideoId('dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    });

    it('extracts from youtu.be short links (stripping query)', () => {
      expect(extractVideoId('https://youtu.be/dQw4w9WgXcQ?si=abc123')).toBe('dQw4w9WgXcQ');
    });

    it('extracts from watch?v= URLs with extra params', () => {
      expect(extractVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s&list=PL')).toBe('dQw4w9WgXcQ');
    });

    it('extracts from /embed/, /shorts/, /live/, /v/ forms', () => {
      expect(extractVideoId('https://www.youtube.com/embed/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
      expect(extractVideoId('https://www.youtube.com/shorts/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
      expect(extractVideoId('https://www.youtube.com/live/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
      expect(extractVideoId('https://www.youtube.com/v/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    });

    it('handles m. and music. subdomains and youtube-nocookie', () => {
      expect(extractVideoId('https://m.youtube.com/watch?v=dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
      expect(extractVideoId('https://music.youtube.com/watch?v=dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
      expect(extractVideoId('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    });

    it('trims surrounding whitespace', () => {
      expect(extractVideoId('  https://youtu.be/dQw4w9WgXcQ  ')).toBe('dQw4w9WgXcQ');
    });

    it('returns null for non-YouTube hosts', () => {
      expect(extractVideoId('https://vimeo.com/12345678')).toBeNull();
      expect(extractVideoId('https://example.com/watch?v=dQw4w9WgXcQ')).toBeNull();
    });

    it('returns null for malformed or empty input', () => {
      expect(extractVideoId('')).toBeNull();
      expect(extractVideoId('not a url')).toBeNull();
      expect(extractVideoId('https://www.youtube.com/watch?v=short')).toBeNull();
      expect(extractVideoId('https://www.youtube.com/results?search_query=cats')).toBeNull();
    });

    it('rejects an over-length "id" that is not exactly 11 chars', () => {
      expect(extractVideoId('dQw4w9WgXcQEXTRA')).toBeNull();
      expect(extractVideoId('https://youtu.be/dQw4w9WgXcQEXTRA')).toBeNull();
    });
  });

  describe('isYoutubeUrl', () => {
    it('is true for YouTube links and bare IDs, false otherwise', () => {
      expect(isYoutubeUrl('https://youtu.be/dQw4w9WgXcQ')).toBe(true);
      expect(isYoutubeUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe(true);
      expect(isYoutubeUrl('dQw4w9WgXcQ')).toBe(true);
      expect(isYoutubeUrl('https://example.com')).toBe(false);
      expect(isYoutubeUrl('garbage')).toBe(false);
    });
  });

  describe('selectVideoIds', () => {
    it('dedupes by video ID across different URL forms', () => {
      const { videoIds } = selectVideoIds([
        'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        'https://youtu.be/dQw4w9WgXcQ',
        'https://www.youtube.com/shorts/dQw4w9WgXcQ',
      ], 3);
      expect(videoIds).toEqual(['dQw4w9WgXcQ']);
    });

    it('caps to max while preserving order', () => {
      const { videoIds } = selectVideoIds([
        'https://youtu.be/aaaaaaaaaaa',
        'https://youtu.be/bbbbbbbbbbb',
        'https://youtu.be/ccccccccccc',
        'https://youtu.be/ddddddddddd',
      ], 2);
      expect(videoIds).toEqual(['aaaaaaaaaaa', 'bbbbbbbbbbb']);
    });

    it('reports non-YouTube links as rejected', () => {
      const { videoIds, rejected } = selectVideoIds([
        'https://youtu.be/dQw4w9WgXcQ',
        'https://example.com/article',
        'nonsense',
      ], 3);
      expect(videoIds).toEqual(['dQw4w9WgXcQ']);
      expect(rejected).toEqual(['https://example.com/article', 'nonsense']);
    });

    it('does not count duplicates against the cap', () => {
      const { videoIds } = selectVideoIds([
        'https://youtu.be/aaaaaaaaaaa',
        'https://youtu.be/aaaaaaaaaaa',
        'https://youtu.be/bbbbbbbbbbb',
      ], 2);
      expect(videoIds).toEqual(['aaaaaaaaaaa', 'bbbbbbbbbbb']);
    });
  });

  describe('watchUrl', () => {
    it('builds a canonical watch URL', () => {
      expect(watchUrl('dQw4w9WgXcQ')).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    });
  });
});
