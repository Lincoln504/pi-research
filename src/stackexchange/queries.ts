/**
 * Stack Exchange API Query Builders
 */

import type { SortOrder, SortActivity, SortReputation } from './types.ts';

export interface SearchParams {
  query?: string;
  title?: string;
  tagged?: string | string[];
  nottagged?: string | string[];
  intitle?: string;
  accepted?: boolean;
  answers?: number;
  body?: string;
  closed?: boolean;
  migrated?: boolean;
  notice?: string;
  user?: number;
  url?: string;
  views?: number;
  wiki?: boolean;
  page?: number;
  pagesize?: number;
  sort?: SortActivity;
  order?: SortOrder;
  site?: string;
  filter?: string;
}

export interface QuestionParams {
  ids: string | number | (string | number)[];
  site?: string;
  filter?: string;
  sort?: SortActivity;
  order?: SortOrder;
  page?: number;
  pagesize?: number;
}

export interface UserParams {
  ids: string | number | (string | number)[];
  site?: string;
  filter?: string;
  sort?: SortReputation;
  order?: SortOrder;
  page?: number;
  pagesize?: number;
}

export interface SitesParams {
  page?: number;
  pagesize?: number;
}

/**
 * Build URL search parameters from object
 */
export function buildSearchParams(params: SearchParams): URLSearchParams {
  const searchParams = new URLSearchParams();

  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) {
      continue;
    }

    if (typeof value === 'boolean') {
      searchParams.set(key, value ? 'true' : 'false');
    } else if (Array.isArray(value)) {
      searchParams.set(key, value.join(';')); // Stack Exchange uses semicolons for arrays
    } else {
      searchParams.set(key, String(value));
    }
  }

  return searchParams;
}

/**
 * Build search/advanced query
 */
export function buildSearchQuery(params: SearchParams): URLSearchParams {
  return buildSearchParams(params);
}

/**
 * Build questions query
 */
export function buildQuestionsQuery(params: QuestionParams): URLSearchParams {
  const searchParams = new URLSearchParams();

  searchParams.set('order', params.order ?? 'desc');
  searchParams.set('sort', params.sort ?? 'activity');
  searchParams.set('site', params.site ?? 'stackoverflow.com');
  if (params.filter) {
    searchParams.set('filter', params.filter);
  }
  if (params.page) {
    searchParams.set('page', String(params.page));
  }
  if (params.pagesize) {
    searchParams.set('pagesize', String(params.pagesize));
  }

  return searchParams;
}

/**
 * Build user query
 */
export function buildUserQuery(params: UserParams): URLSearchParams {
  const searchParams = new URLSearchParams();

  searchParams.set('site', params.site ?? 'stackoverflow.com');
  searchParams.set('order', params.order ?? 'desc');
  searchParams.set('sort', params.sort ?? 'reputation');
  if (params.filter) {
    searchParams.set('filter', params.filter);
  }
  if (params.page) {
    searchParams.set('page', String(params.page));
  }
  if (params.pagesize) {
    searchParams.set('pagesize', String(params.pagesize));
  }

  return searchParams;
}

/**
 * Build sites query
 */
export function buildSitesQuery(params?: SitesParams): URLSearchParams {
  const searchParams = new URLSearchParams();

  if (params?.page) {
    searchParams.set('page', String(params.page));
  }
  if (params?.pagesize) {
    searchParams.set('pagesize', String(params.pagesize));
  }

  return searchParams;
}

/**
 * Pre-defined filters for common use cases
 */
export const Filters = {
  // Get question body and answers with body
  WITH_BODY: '!9_bDDxJY5',
  // Minimal info - just title and score
  MINIMAL: '!-*f(6rL6Wq', // Minimal info - title, score, tags, owner
  // Full details including comments
  FULL: '!*S15IVPvS5',
  // Get answers with body
  ANSWERS_WITH_BODY: '!9_bDE(fI5',
};

/**
 * Parse IDs from query string (handle both single IDs and comma/semicolon separated)
 */
export function parseIds(ids: string | number | (string | number)[]): string {
  if (Array.isArray(ids)) {
    return ids.join(';');
  }
  return String(ids);
}
