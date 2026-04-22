/**
 * Report Extraction Utilities
 *
 * Extract process notes from researcher reports for lead evaluator synthesis.
 */

/**
 * Extract "Research Process Notes" sections from completed reports
 * Returns empty string if no notes found
 */
export function extractProcessNotes(
  completed: Array<{ id: string; query: string; report?: string }>
): string {
  const notes: Array<{
    researcher: string;
    query: string;
    notes: string;
  }> = [];

  for (const aspect of completed) {
    const report = aspect.report;
    if (!report) continue;

    // Extract notes section (case-insensitive, allows ### or ####)
    // Use [^#]*? to match content up to next # heading (not across newlines)
    const match = report.match(/###?\s*Research\s*Process\s*Notes\s*\n([^#]*?)(?=\n###|$)/i);
    
    // Check if match exists and content is non-empty after trimming whitespace
    const notesContent = match ? match[1]?.trim() : '';
    if (match && notesContent && notesContent.length > 0) {
      notes.push({
        researcher: aspect.id,
        query: aspect.query,
        notes: notesContent
      });
    }
  }

  if (notes.length === 0) {
    return '';
  }

  // Simple markdown output - lead evaluator can restructure if needed
  let output = '## Research Process Notes (Aggregated)\n\n';
  output += 'The following notes were provided by researchers:\n\n';

  for (const { researcher, query, notes: noteText } of notes) {
    output += `### Researcher ${researcher}: ${query}\n\n${noteText}\n\n`;
  }

  return output;
}
