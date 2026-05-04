/**
 * Compact output formatter for Stack Exchange results
 */

import type { Question, Answer, User, Site } from '../types.ts';

export function formatQuestionsCompact(questions: Question[]): string {
  if (questions.length === 0) {
    return 'No questions found.';
  }

  const lines: string[] = [];
  let index = 1;
  for (const q of questions) {
    const accepted = q.accepted_answer_id ? '✓' : ' ';
    lines.push(`${index}. ${accepted} [${q.title}](${q.link}) (${q.score} pts, ${q.answer_count} ans, ${q.view_count} views)`);
    index++;
  }
  return lines.join('\n');
}

export function formatAnswersCompact(answers: Answer[]): string {
  if (answers.length === 0) {
    return 'No answers found.';
  }

  const lines: string[] = [];
  let index = 1;
  for (const a of answers) {
    const accepted = a.is_accepted ? '✓' : ' ';
    const authorName = a.owner?.display_name ?? 'Unknown';
    lines.push(`${index}. ${accepted} by ${authorName} (${a.score} pts)`);
    index++;
  }
  return lines.join('\n');
}

export function formatUsersCompact(users: User[]): string {
  if (users.length === 0) {
    return 'No users found.';
  }

  const lines: string[] = [];
  let index = 1;
  for (const u of users) {
    lines.push(`${index}. ${u.display_name} (rep: ${u.reputation}, 🥇${u.badge_counts.gold} 🥈${u.badge_counts.silver} 🥉${u.badge_counts.bronze})`);
    index++;
  }
  return lines.join('\n');
}

export function formatSitesCompact(sites: Site[]): string {
  if (sites.length === 0) {
    return 'No sites found.';
  }

  const lines: string[] = [];
  let index = 1;
  for (const s of sites) {
    lines.push(`${index}. ${s.name} (\`${s.api_site_parameter}\`) - ${s.audience || 'N/A'}`);
    index++;
  }
  return lines.join('\n');
}
