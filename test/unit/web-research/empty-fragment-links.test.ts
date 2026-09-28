/**
 * Converter post-processing: empty same-page links (`[](#cb2-1)`) are dropped.
 *
 * Documentation generators (Quarto, nbdev) put an empty anchor before every code
 * line; the native converter (the default) turned each into `[](#cb2-1)`,
 * cluttering every code block in research scrapes and the knowledge store. The
 * JS fallback already dropped them inside code; its test guards that both paths
 * stay clean.
 */
import { describe, it, expect } from 'vitest';
import {
  stripEmptyFragmentLinks,
  cleanConvertedMarkdown,
  createJsMarkdownConverter,
  createNativeMarkdownConverter,
} from '../../../src/web-research/scraper-utils.ts';

// Shape of a Quarto code block (llmstxt.org), plus a heading anchor.
const QUARTO_HTML = `
<h2 id="format">Format <a class="anchor" href="#format"></a></h2>
<p>See the <a href="#example">example</a> below.</p>
<div class="sourceCode"><pre class="sourceCode"><code class="sourceCode">
<span id="cb2-1"><a href="#cb2-1" aria-hidden="true" tabindex="-1"></a># Title</span>
<span id="cb2-2"><a href="#cb2-2" aria-hidden="true" tabindex="-1"></a></span>
<span id="cb2-3"><a href="#cb2-3" aria-hidden="true" tabindex="-1"></a>&gt; Optional description goes here</span>
</code></pre></div>
`;

describe('stripEmptyFragmentLinks', () => {
  it('drops per-line code anchors and other empty same-page links', () => {
    const md = '```\n[](#cb2-1)# Title\n[](#cb2-2)\n[](#cb2-3)> desc\n```\n\n## Format [](#format)\n\n[](#top "Back to top")Text';
    expect(stripEmptyFragmentLinks(md)).toBe('```\n# Title\n\n> desc\n```\n\n## Format \n\nText');
  });

  it('keeps links with text, and empty links to other pages', () => {
    const md = '[Intro](#intro) and [](https://x.test/#a) and [](page.html)';
    expect(stripEmptyFragmentLinks(md)).toBe(md);
  });
});

describe('cleanConvertedMarkdown', () => {
  it('drops heading anchors that wrap an icon (empty only once the image is stripped)', () => {
    // GitHub README heading: the anchor link wraps an octicon SVG.
    const md = '# Payloads All The Things\n\n[![](https://github.githubassets.com/link.svg)](#payloads-all-the-things)\n\nA list of payloads.';
    expect(cleanConvertedMarkdown(md)).toBe('# Payloads All The Things\n\nA list of payloads.');
  });
});

describe('converters drop empty same-page links', () => {
  it('JS converter', async () => {
    const md = await createJsMarkdownConverter()(QUARTO_HTML);
    expect(md).not.toMatch(/\[\]\(#/);
    expect(md).toContain('# Title');
    expect(md).toContain('> Optional description goes here');
    expect(md).toContain('[example](#example)');
  });

  it('native converter', async () => {
    let mod: any;
    try {
      const raw: any = await import('@kreuzberg/html-to-markdown-node');
      mod = raw.default ?? raw;
    } catch {
      return; // native binding unavailable on this platform: the JS path above covers the rule
    }
    const md = await createNativeMarkdownConverter(mod)(QUARTO_HTML);
    expect(md).not.toMatch(/\[\]\(#/);
    expect(md).toContain('# Title');
    expect(md).toContain('[example](#example)');
  });
});
