import { describe, it, expect } from 'vitest';
import { Chunker } from '../../../src/knowledge/chunker.ts';

describe('Chunker', () => {
  const chunker = new Chunker({
    targetSize: 100,
    overlap: 20,
  });

  it('should split simple text into chunks', () => {
    const text = 'This is a long text that should be split into multiple chunks because it exceeds the target size set in the options.';
    const chunks = chunker.chunk(text);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0].text.length).toBeLessThanOrEqual(120); // target + overlap
  });

  it('should split on headings', () => {
    const text = '# Heading 1\nSome content for heading 1.\n## Subheading\nSome more content.';
    const chunks = chunker.chunk(text);
    expect(chunks.some(c => c.text.includes('# Heading 1'))).toBe(true);
    expect(chunks.some(c => c.text.includes('## Subheading'))).toBe(true);
  });

  it('should keep code blocks atomic', () => {
    const text = 'Some text\n```js\nconst x = 1;\nconst y = 2;\nconst z = 3;\n```\nMore text';
    const smallChunker = new Chunker({ targetSize: 10, overlap: 0 });
    const chunks = smallChunker.chunk(text);
    // The code block should be in a single chunk if possible, or at least not split in the middle of a line?
    // Actually mandate says "never be split mid-block".
    const codeBlockChunks = chunks.filter(c => c.text.includes('const x = 1;'));
    expect(codeBlockChunks[0].text).toContain('```js\nconst x = 1;\nconst y = 2;\nconst z = 3;\n```');
  });

  it('should allow lossless reconstruction', () => {
    const text = '# Test\n' + 'Line of text.\n'.repeat(50);
    const chunks = chunker.chunk(text);
    
    let reconstructed = chunks[0].text;
    for (let i = 1; i < chunks.length; i++) {
      reconstructed += chunks[i].text.slice(chunks[i].actual_overlap);
    }
    
    expect(reconstructed).toBe(text);
  });
});
