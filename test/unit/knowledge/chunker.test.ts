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
    const chunk = chunks[0];
    if (!chunk) throw new Error('Chunk not found');
    expect(chunk.text.length).toBeLessThanOrEqual(120); // target + overlap
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
    expect(codeBlockChunks[0]!.text).toContain('```js\nconst x = 1;\nconst y = 2;\nconst z = 3;\n```');
  });

  it('should split on sentence boundaries', () => {
    const text = 'First long sentence that goes on for a bit. Second long sentence that also goes on for quite some time! Third sentence? Yes.';
    const smallChunker = new Chunker({ targetSize: 45, overlap: 5 });
    const chunks = smallChunker.chunk(text);
    // Target size is 45. 
    // 'First long sentence that goes on for a bit.' is 43 chars.
    // So it should split right after the period.
    expect(chunks[0]!.text).toBe('First long sentence that goes on for a bit.');
    // Check lossless reconstruction
    let reconstructed = chunks[0]!.text;
    for (let i = 1; i < chunks.length; i++) {
      reconstructed += chunks[i]!.text.slice(chunks[i]!.actual_overlap);
    }
    expect(reconstructed).toBe(text);
  });

  it('should allow lossless reconstruction', () => {
    const text = '# Test\n' + 'Line of text.\n'.repeat(50);
    const chunks = chunker.chunk(text);
    
    let reconstructed = chunks[0]!.text;
    for (let i = 1; i < chunks.length; i++) {
      reconstructed += chunks[i]!.text.slice(chunks[i]!.actual_overlap);
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
    expect(chunks[0]!.text).toBe(short);
    expect(chunks[0]!.actual_overlap).toBe(0);
  });

  it('first chunk always has actual_overlap of 0 regardless of overlap setting', () => {
    const text = 'A '.repeat(200);
    const chunks = chunker.chunk(text);
    expect(chunks[0]!.actual_overlap).toBe(0);
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

    let reconstructed = chunks[0]!.text;
    for (let i = 1; i < chunks.length; i++) {
      reconstructed += chunks[i]!.text.slice(chunks[i]!.actual_overlap);
    }

    expect(reconstructed).toBe(text);
  });

  it('keeps forward progress when the overlap step re-enters a code block (no per-character slivers)', () => {
    // A fenced block that straddles a chunk boundary: the first chunk extends to
    // the closing fence, then the overlap plants the next start INSIDE the block.
    // Without the forward-progress guard this degenerates into one chunk per
    // character (observed: 228 chunks for ~7k chars with the shipped e5 config).
    const c = new Chunker({ targetSize: 1500, overlap: 225 });
    const fenced = '```\n' + 'x'.repeat(1571) + '\n```';
    const text = 'a'.repeat(1000) + '\n' + fenced + '\n' + 'b'.repeat(4400);
    const chunks = c.chunk(text);

    // Upper bound: ceil(len / (targetSize - overlap)) plus slack for extensions.
    expect(chunks.length).toBeLessThan(12);

    // Every chunk after the first must cover text beyond the previous coverage.
    let covered = chunks[0]!.text.length;
    for (let i = 1; i < chunks.length; i++) {
      const advance = chunks[i]!.text.length - chunks[i]!.actual_overlap;
      expect(advance).toBeGreaterThan(0);
      covered += advance;
    }
    expect(covered).toBe(text.length);

    let reconstructed = chunks[0]!.text;
    for (let i = 1; i < chunks.length; i++) {
      reconstructed += chunks[i]!.text.slice(chunks[i]!.actual_overlap);
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

  describe('surrogate-pair safety', () => {
    // Locates an unpaired UTF-16 surrogate in `str`: a high surrogate
    // (0xD800-0xDBFF) not immediately followed by a low surrogate, or a low
    // surrogate (0xDC00-0xDFFF) not immediately preceded by (and consumed
    // with) a high surrogate. Returns the offending code-unit index, or null
    // if the string is well-formed UTF-16. This is exactly the shape of
    // corruption Node's UTF-16->UTF-8 conversion silently replaces with
    // U+FFFD (JSON serialization, HTTP bodies, N-API string marshalling).
    function findUnpairedSurrogate(str: string): number | null {
      for (let i = 0; i < str.length; i++) {
        const code = str.charCodeAt(i);
        if (code >= 0xd800 && code <= 0xdbff) {
          const next = str.charCodeAt(i + 1);
          if (Number.isNaN(next) || next < 0xdc00 || next > 0xdfff) {
            return i;
          }
          i++; // valid pair — skip its low half
        } else if (code >= 0xdc00 && code <= 0xdfff) {
          return i;
        }
      }
      return null;
    }

    it('does not emit a lone high surrogate when a chunk boundary (end) lands mid-pair', () => {
      // targetSize=20, overlap=0, with only 'a' filler around the emoji so
      // none of the code-block/heading/sentence/newline/space heuristics can
      // move `end` off start+targetSize: the boundary lands exactly between
      // the emoji's high surrogate (index 19) and low surrogate (index 20).
      const emoji = '\u{1F389}'; // 🎉 — high 0xD83C, low 0xDF89
      const text = 'a'.repeat(19) + emoji + 'a'.repeat(20);
      const c = new Chunker({ targetSize: 20, overlap: 0 });
      const chunks = c.chunk(text);

      // Pre-fix this first chunk is 19 'a's + the lone high surrogate (20
      // units) — exactly the boundary the fix must pull back by one unit, so
      // the fixed chunk is 19 units (just the 'a's, high surrogate excluded).
      expect(chunks[0]!.text.length).toBe(19);

      for (const chunk of chunks) {
        expect(findUnpairedSurrogate(chunk.text)).toBeNull();
      }

      // The emoji must survive fully intact somewhere in the output.
      expect(chunks.some(ch => ch.text.includes(emoji))).toBe(true);

      let reconstructed = chunks[0]!.text;
      for (let i = 1; i < chunks.length; i++) {
        reconstructed += chunks[i]!.text.slice(chunks[i]!.actual_overlap);
      }
      expect(reconstructed).toBe(text);
    });

    it('does not emit a lone low surrogate when the overlap-derived start lands mid-pair', () => {
      // targetSize=30, overlap=10: the FIRST chunk's end (30) lands cleanly
      // past the emoji (at indices 19-20), so the end-side fix never touches
      // it. But start = end - overlap = 30 - 10 = 20 lands exactly on the
      // emoji's low surrogate — a boundary picked by raw overlap arithmetic,
      // independent of any `end` adjustment, so it needs its own fix.
      const emoji = '\u{1F389}';
      const text = 'a'.repeat(19) + emoji + 'a'.repeat(40);
      const c = new Chunker({ targetSize: 30, overlap: 10 });
      const chunks = c.chunk(text);

      expect(chunks.length).toBeGreaterThan(1);

      for (const chunk of chunks) {
        expect(findUnpairedSurrogate(chunk.text)).toBeNull();
      }

      expect(chunks.some(ch => ch.text.includes(emoji))).toBe(true);

      let reconstructed = chunks[0]!.text;
      for (let i = 1; i < chunks.length; i++) {
        reconstructed += chunks[i]!.text.slice(chunks[i]!.actual_overlap);
      }
      expect(reconstructed).toBe(text);
    });

    it('never produces an unpaired surrogate across randomized astral-char placements', () => {
      // Broader sweep: sprinkle astral characters (emoji from different
      // planes, including a CJK Extension B/Compatibility-Supplement char)
      // throughout otherwise plain text at several targetSize/overlap
      // combinations, so boundaries land mid-pair at varying offsets.
      const astral = ['\u{1F389}', '\u{1F600}', '\u{20000}', '\u{2F894}'];
      const configs = [
        { targetSize: 15, overlap: 0 },
        { targetSize: 20, overlap: 5 },
        { targetSize: 37, overlap: 11 },
      ];
      for (const config of configs) {
        let text = '';
        for (let i = 0; i < 300; i++) {
          text += (i % 7 === 0) ? astral[i % astral.length] : 'x';
        }
        const c = new Chunker(config);
        const chunks = c.chunk(text);

        for (const chunk of chunks) {
          expect(findUnpairedSurrogate(chunk.text)).toBeNull();
        }

        let reconstructed = chunks[0]!.text;
        for (let i = 1; i < chunks.length; i++) {
          reconstructed += chunks[i]!.text.slice(chunks[i]!.actual_overlap);
        }
        expect(reconstructed).toBe(text);
      }
    });
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

          let reconstructed = chunks[0]!.text;
          for (let i = 1; i < chunks.length; i++) {
            reconstructed += chunks[i]!.text.slice(chunks[i]!.actual_overlap);
          }
          
          if (reconstructed !== text) {
            expect(reconstructed).toBe(text);
          }
        }
      }
    });
  });
});
