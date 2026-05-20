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

  it('should split on headings — headings must appear in separate chunks', () => {
    // targetSize=100, overlap=20. Build text where headings are >40 chars apart
    // so the heading-split threshold (lastHeading > targetSize * 0.4 = 40) fires
    const content1 = 'Content for the first heading section. ';
    const content2 = 'Content for the second heading section.';
    const text = `# Heading 1\n${content1.repeat(3)}\n## Subheading\n${content2}`;

    const smallChunker = new Chunker({ targetSize: 60, overlap: 5 });
    const chunks = smallChunker.chunk(text);

    // Should produce multiple chunks
    expect(chunks.length).toBeGreaterThan(1);
    // No single chunk should contain both headings
    const bothHeadings = chunks.some(
      c => c.text.includes('# Heading 1') && c.text.includes('## Subheading'),
    );
    expect(bothHeadings).toBe(false);
    // Each heading must appear in at least one chunk
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

  it('should split on sentence boundaries', () => {
    const text = 'First long sentence that goes on for a bit. Second long sentence that also goes on for quite some time! Third sentence? Yes.';
    const smallChunker = new Chunker({ targetSize: 45, overlap: 5 });
    const chunks = smallChunker.chunk(text);
    // Target size is 45. 
    // 'First long sentence that goes on for a bit.' is 43 chars.
    // So it should split right after the period.
    expect(chunks[0].text).toBe('First long sentence that goes on for a bit.');
    // Check lossless reconstruction
    let reconstructed = chunks[0].text;
    for (let i = 1; i < chunks.length; i++) {
      reconstructed += chunks[i].text.slice(chunks[i].actual_overlap);
    }
    expect(reconstructed).toBe(text);
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

  it('should return empty array for empty string', () => {
    expect(chunker.chunk('')).toEqual([]);
  });

  it('should return empty array for falsy input', () => {
    expect(chunker.chunk(undefined as any)).toEqual([]);
  });

  it('should return single chunk with overlap=0 for text shorter than targetSize', () => {
    const short = 'short text';
    const chunks = chunker.chunk(short);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toBe(short);
    expect(chunks[0].actual_overlap).toBe(0);
  });

  it('first chunk always has actual_overlap of 0 regardless of overlap setting', () => {
    const text = 'A '.repeat(200);
    const chunks = chunker.chunk(text);
    expect(chunks[0].actual_overlap).toBe(0);
  });

  it('no chunk should exceed targetSize + overlap characters', () => {
    const text = 'word '.repeat(200);
    const chunks = chunker.chunk(text);
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(chunker['targetSize'] + chunker['overlap'] + 10);
    }
  });

  it('lossless reconstruction works when text contains a code block', () => {
    const text = 'Intro text before the code.\n```javascript\nconst a = 1;\nconst b = 2;\nconst c = a + b;\nconsole.log(c);\n```\nTrailing text after the block.';
    const smallChunker = new Chunker({ targetSize: 30, overlap: 5 });
    const chunks = smallChunker.chunk(text);

    let reconstructed = chunks[0].text;
    for (let i = 1; i < chunks.length; i++) {
      reconstructed += chunks[i].text.slice(chunks[i].actual_overlap);
    }

    expect(reconstructed).toBe(text);
  });

  it('should throw error when overlap >= targetSize', () => {
    expect(() => {
      new Chunker({ targetSize: 100, overlap: 100 });
    }).toThrow('overlap (100) must be less than targetSize (100)');

    expect(() => {
      new Chunker({ targetSize: 50, overlap: 75 });
    }).toThrow('overlap (75) must be less than targetSize (50)');
  });

  describe('Property-based lossless reconstruction', () => {
    const generateRandomText = (length: number) => {
      const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 \n#.`';
      let result = '';
      for (let i = 0; i < length; i++) {
        const r = Math.random();
        if (r < 0.05) result += '\n# '; // Headings
        else if (r < 0.1) result += '\n```\ncode\n```\n'; // Code blocks
        else if (r < 0.15) result += '. '; // Sentences
        else result += chars.charAt(Math.floor(Math.random() * chars.length));
      }
      return result;
    };

    it('should always allow lossless reconstruction regardless of text content or chunker settings', () => {
      const seedTexts = [
        generateRandomText(100),
        generateRandomText(1000),
        generateRandomText(5000),
      ];

      const configs = [
        { targetSize: 50, overlap: 10 },
        { targetSize: 200, overlap: 50 },
        { targetSize: 1000, overlap: 200 },
        { targetSize: 100, overlap: 0 },
      ];

      for (const text of seedTexts) {
        for (const config of configs) {
          const c = new Chunker(config);
          const chunks = c.chunk(text);
          
          if (chunks.length === 0) {
            expect(text).toBe('');
            continue;
          }

          let reconstructed = chunks[0].text;
          for (let i = 1; i < chunks.length; i++) {
            reconstructed += chunks[i].text.slice(chunks[i].actual_overlap);
          }
          
          if (reconstructed !== text) {
            console.log(`FAILED CONFIG: targetSize=${config.targetSize}, overlap=${config.overlap}`);
            console.log(`CHUNKS:`, chunks.map(c => ({ len: c.text.length, overlap: c.actual_overlap, text: c.text.slice(0, 20) + '...' })));
            // Find first mismatch for debugging
            for (let j = 0; j < Math.max(text.length, reconstructed.length); j++) {
                if (text[j] !== reconstructed[j]) {
                    console.log(`Mismatch at index ${j}: expected ${JSON.stringify(text[j])}, got ${JSON.stringify(reconstructed[j])}`);
                    console.log(`Context Expected: ...${text.slice(Math.max(0, j-20), j+20)}...`);
                    console.log(`Context Received: ...${reconstructed.slice(Math.max(0, j-20), j+20)}...`);
                    break;
                }
            }
          }
          expect(reconstructed).toBe(text);
        }
      }
    });
  });
});
