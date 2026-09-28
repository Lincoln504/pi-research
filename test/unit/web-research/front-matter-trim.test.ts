/**
 * Converter post-processing: the front matter the native converter builds from
 * <meta> tags is trimmed to title, description, author and dates.
 */
import { describe, it, expect } from 'vitest';
import { trimFrontMatter, cleanConvertedMarkdown } from '../../../src/web-research/scraper-utils.ts';

const fm = (...lines: string[]) => `---\n${lines.join('\n')}\n---\n\n# Body\n\ntext`;

describe('trimFrontMatter', () => {
  it('drops tracking/verification noise, keeps title and description (GitHub shape)', () => {
    const md = fm(
      'meta-analytics-location: /<user-name>/<repo-name>',
      'meta-browser-stats-url: https://api.github.com/_private/browser/stats',
      'meta-description: A list of useful payloads',
      'meta-fetch-nonce: v2:6438ddd3-e3dc-5175-0595-92e50707791a',
      'meta-og:title: GitHub - swisskyrepo/PayloadsAllTheThings',
      'meta-twitter:description: A list of useful payloads',
      'title: GitHub - swisskyrepo/PayloadsAllTheThings: A list of useful payloads',
    );
    expect(trimFrontMatter(md)).toBe(fm(
      'title: GitHub - swisskyrepo/PayloadsAllTheThings: A list of useful payloads',
      'meta-description: A list of useful payloads',
    ));
  });

  it('keeps author and dates (Quarto, news, papers)', () => {
    expect(trimFrontMatter(fm(
      'meta-author: Jeremy Howard', 'meta-dcterms.date: 2024-09-03', 'meta-generator: quarto-1.5',
      'meta-twitter:creator: @jeremyphoward', 'title: The /llms.txt file',
    ))).toBe(fm('title: The /llms.txt file', 'meta-author: Jeremy Howard', 'meta-dcterms.date: 2024-09-03'));

    expect(trimFrontMatter(fm(
      'meta-article:modified_time: 2024-10-15T05:12:42+00:00',
      'meta-article:published_time: 2024-10-14T19:06:27+00:00',
      'meta-description: A quirk in the Unicode standard',
      'title: Invisible text',
    ))).toBe(fm(
      'title: Invisible text', 'meta-description: A quirk in the Unicode standard',
      'meta-article:published_time: 2024-10-14T19:06:27+00:00', 'meta-article:modified_time: 2024-10-15T05:12:42+00:00',
    ));

    expect(trimFrontMatter(fm(
      'meta-citation_author: Fritz, Mario', 'meta-citation_date: 2023/02/23',
      'meta-citation_pdf_url: https://arxiv.org/pdf/2302.12173', 'meta-citation_title: Not what you\'ve signed up for',
    ))).toBe(fm('meta-citation_title: Not what you\'ve signed up for', 'meta-citation_author: Fritz, Mario', 'meta-citation_date: 2023/02/23'));
  });

  it('prefers the plain key in each slot, falling back to Open Graph', () => {
    expect(trimFrontMatter(fm('meta-og:description: og text', 'meta-og:title: OG title')))
      .toBe(fm('meta-og:title: OG title', 'meta-og:description: og text'));
  });

  it('keeps a multi-line value whole', () => {
    expect(trimFrontMatter(fm('meta-description: first line', '  second line', 'meta-viewport: width=device-width')))
      .toBe(fm('meta-description: first line', '  second line'));
  });

  it('drops the block when nothing useful is in it', () => {
    expect(trimFrontMatter(fm('meta-viewport: width=device-width', 'meta-robots: index'))).toBe('# Body\n\ntext');
  });

  it('leaves text without converter front matter alone', () => {
    expect(trimFrontMatter('# Title\n\n---\n\ntext')).toBe('# Title\n\n---\n\ntext');
    expect(trimFrontMatter('---\nno closing fence')).toBe('---\nno closing fence');
  });

  it('is part of the shared converter post-processing', () => {
    expect(cleanConvertedMarkdown(fm('meta-fetch-nonce: x', 'title: T') + '\n\n[](#anchor)')).toBe('---\ntitle: T\n---\n\n# Body\n\ntext');
  });
});
