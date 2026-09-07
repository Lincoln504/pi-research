/**
 * Table output formatter for Stack Exchange results
 */

import type { Question, Answer, User, Site } from '../types.ts';
import { plainUrl, fenceBlock } from '../../utils/plain-url.ts';

export function formatQuestionsTable(questions: Question[]): string {
  if (questions.length === 0) {
    return 'No questions found.\n';
  }

  let output = '# Stack Exchange Questions\n\n';
  output += `Found: ${questions.length} question${questions.length !== 1 ? 's' : ''}\n\n`;

  for (const q of questions) {
    output += `## ${q.title}\n\n`;
    output += `- **Score:** ${q.score}\n`;
    output += `- **Views:** ${q.view_count}\n`;
    output += `- **Answers:** ${q.answer_count}${q.accepted_answer_id ? ' [accepted]' : ''}\n`;
    output += `- **Tags:** ${q.tags.join(', ')}\n`;
    if (q.owner) {
      output += `- **Author:** ${q.owner.display_name} (rep: ${q.owner.reputation})\n`;
    }
    // plainUrl: URLs in tool output are data, not interactive links — see
    // plain-url.ts. Bare URLs would be GFM-autolinked into clickable OSC 8
    // hyperlinks by markdown renderers (accidental browser-tab opens).
    output += `- **Link:** ${plainUrl(q.link)}\n`;
    output += `- **Created:** ${new Date(q.creation_date * 1000).toLocaleString()}\n`;

    if (q.body) {
      // Truncate long bodies to a preview rather than dropping them entirely — the
      // previous `length < 1000` guard omitted the Body line for the longest
      // questions (the ones most in need of truncation).
      const body = q.body.length > 500 ? `${q.body.substring(0, 500)}...` : q.body;
      // Third-party body text must never be rendered as markdown — it can
      // carry arbitrary links (markdown injection → clickable browser tabs).
      // The fence MUST start on its own line: CommonMark only recognizes a
      // fenced code block when the opening fence begins the line; inline
      // after "**Body:**" it degrades to paragraph text and marked renders
      // embedded links clickable (verified against pi's bundled marked).
      output += `- **Body:**\n\n${fenceBlock(body)}\n`;
    }

    output += '\n---\n\n';
  }

  return output;
}

export function formatAnswersTable(answers: Answer[]): string {
  if (answers.length === 0) {
    return 'No answers found.\n';
  }

  let output = '# Stack Exchange Answers\n\n';
  output += `Found: ${answers.length} answer${answers.length !== 1 ? 's' : ''}\n\n`;

  for (const a of answers) {
    const authorName = a.owner?.display_name ?? 'Unknown';
    output += `## Answer by ${authorName}\n\n`;
    output += `- **Score:** ${a.score}${a.is_accepted ? ' [Accepted]' : ''}\n`;
    if (a.owner) {
      output += `- **Author:** ${a.owner.display_name} (rep: ${a.owner.reputation})\n`;
    }
    output += `- **Question ID:** ${a.question_id}\n`;
    output += `- **Created:** ${new Date(a.creation_date * 1000).toLocaleString()}\n`;

    if (a.body) {
      // Truncate long bodies to a preview rather than dropping them entirely — the
      // previous `length < 2000` guard omitted the body for exactly the longest
      // answers (same class as the question-body fix above; answers get a more
      // generous bound since the body is the whole point of an answer).
      const body = a.body.length > 2000 ? `${a.body.substring(0, 2000)}...` : a.body;
      // Same third-party-content rule as the question body above.
      output += `\n### Answer Body\n\n${fenceBlock(body)}\n`;
    }

    output += '\n---\n\n';
  }

  return output;
}

export function formatUsersTable(users: User[]): string {
  if (users.length === 0) {
    return 'No users found.\n';
  }

  let output = '# Stack Exchange Users\n\n';
  output += `Found: ${users.length} user${users.length !== 1 ? 's' : ''}\n\n`;

  for (const u of users) {
    output += `## ${u.display_name}\n\n`;
    output += `- **Reputation:** ${u.reputation}\n`;
    output += `- **Badges:** gold:${u.badge_counts.gold} silver:${u.badge_counts.silver} bronze:${u.badge_counts.bronze}\n`;
    output += `- **User ID:** ${u.user_id}\n`;
    output += `- **Member since:** ${new Date(u.creation_date * 1000).toLocaleDateString()}\n`;
    if (u.location) {
      output += `- **Location:** ${u.location}\n`;
    }
    if (u.website_url) {
      output += `- **Website:** ${plainUrl(u.website_url)}\n`;
    }
    output += `- **Profile:** ${plainUrl(u.link)}\n`;
    output += '\n---\n\n';
  }

  return output;
}

export function formatSitesTable(sites: Site[]): string {
  if (sites.length === 0) {
    return 'No sites found.\n';
  }

  let output = '# Stack Exchange Sites\n\n';
  output += `Found: ${sites.length} site${sites.length !== 1 ? 's' : ''}\n\n`;

  output += '| Site | API Parameter | Audience |\n';
  output += '|------|---------------|----------|\n';

  for (const s of sites) {
    output += `| ${s.name} | \`${s.api_site_parameter}\` | ${s.audience || 'N/A'} |\n`;
  }

  return `${output}\n`;
}

export function formatCompactQuestions(questions: Question[]): string {
  if (questions.length === 0) {
    return 'No questions found.\n';
  }

  let output = '';
  let index = 1;
  for (const q of questions) {
    const accepted = q.accepted_answer_id ? '[accepted]' : '';
    output += `${index}. ${q.title} ${accepted} (score: ${q.score}, answers: ${q.answer_count}) ${plainUrl(q.link)}\n`;
    index++;
  }
  return output;
}
