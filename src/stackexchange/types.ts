/**
 * Stack Exchange API v2.3 Types
 */

export interface StackExchangeConfig {
  defaultSite: string;
  apiKey: string | null;
  requestTimeout: number;  // milliseconds
}

export interface StackExchangeWrapper<T> {
  items: T[];
  has_more: boolean;
  quota_max: number;
  quota_remaining: number;
  backoff?: number;
  error_id?: number;
  error_name?: string;
  error_message?: string;
}

export type SortOrder = 'desc' | 'asc';
export type SortActivity = 'activity' | 'creation' | 'votes' | 'relevance';
export type SortReputation = 'reputation' | 'creation' | 'name' | 'modified';

// Question types
export interface Question {
  tags: string[];
  owner?: {
    account_id: number;
    reputation: number;
    user_id: number;
    user_type: string;
    profile_image: string;
    display_name: string;
    link: string;
  };
  is_answered: boolean;
  view_count: number;
  accepted_answer_id?: number;
  answer_count: number;
  score: number;
  last_activity_date: number;
  creation_date: number;
  last_edit_date?: number;
  question_id: number;
  content_license: string;
  link: string;
  title: string;
  body?: string;
  body_markdown?: string;
}

export interface QuestionWithAnswers extends Question {
  answers?: Answer[];
}

export interface Answer {
  owner?: {
    account_id: number;
    reputation: number;
    user_id: number;
    user_type: string;
    profile_image: string;
    display_name: string;
    link: string;
  };
  is_accepted: boolean;
  score: number;
  last_activity_date: number;
  creation_date: number;
  last_edit_date?: number;
  answer_id: number;
  question_id: number;
  content_license: string;
  body?: string;
  body_markdown?: string;
}

// User types
export interface User {
  badge_counts: {
    bronze: number;
    silver: number;
    gold: number;
  };
  account_id: number;
  is_employee: boolean;
  last_modified_date?: number;
  last_access_date?: number;
  reputation_change_year: number;
  reputation_change_quarter: number;
  reputation_change_month: number;
  reputation_change_week: number;
  reputation_change_day: number;
  reputation: number;
  creation_date: number;
  user_type: string;
  user_id: number;
  accept_rate?: number;
  location?: string;
  website_url?: string;
  link: string;
  profile_image: string;
  display_name: string;
}

// Site types
export interface Site {
  name: string;
  api_site_parameter: string;
  site_url: string;
  audience: string;
  icon_url?: string;
}

// Command parameters
export interface CommandParams {
  command: 'search' | 'get' | 'user' | 'site';
  query?: string;
  id?: string | number;
  site: string;
  limit: number;
  format: 'table' | 'json' | 'compact';
  tags?: string | null;
  full: boolean;
  minimal: boolean;
}

