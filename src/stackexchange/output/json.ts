/**
 * JSON output formatter for Stack Exchange results
 */

import type { Question, Answer, User, Site } from '../types.ts';

export function formatQuestionsJSON(questions: Question[]): string {
  return JSON.stringify(questions, null, 2);
}

export function formatAnswersJSON(answers: Answer[]): string {
  return JSON.stringify(answers, null, 2);
}

export function formatUsersJSON(users: User[]): string {
  return JSON.stringify(users, null, 2);
}

export function formatSitesJSON(sites: Site[]): string {
  return JSON.stringify(sites, null, 2);
}
