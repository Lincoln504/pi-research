export interface Chunk {
  text: string;
  actual_overlap: number;
}

export interface ChunkerOptions {
  targetSize: number;
  overlap: number;
}

import { metrics } from '../utils/metrics.ts';

export class Chunker {
  private targetSize: number;
  private overlap: number;

  constructor(options: ChunkerOptions) {
    if (options.overlap >= options.targetSize) {
      throw new Error(
        `Chunker: overlap (${options.overlap}) must be less than targetSize (${options.targetSize}). ` +
        `This prevents infinite loops during chunking.`
      );
    }
    this.targetSize = options.targetSize;
    this.overlap = options.overlap;
  }

  chunk(text: string): Chunk[] {
    if (!text) {
      metrics.increment('chunker_operations_total', 1, { status: 'empty' });
      return [];
    }

    const startTime = Date.now();
    const chunks: Chunk[] = [];
    let start = 0;
    let prevEnd = 0;
    let codeBlockExtensions = 0;
    let headingExtensions = 0;
    let sentenceExtensions = 0;
    let newlineExtensions = 0;
    let spaceExtensions = 0;

    while (start < text.length) {
      let end = start + this.targetSize;
      
      if (end < text.length) {
        let slice = text.slice(start, end);
        let extendedForCodeBlock = false;
        
        // 0. Code blocks atomicity
        const textBefore = text.slice(0, start);
        const codeBlockMatchesBefore = textBefore.match(/```/g);
        const startsInCodeBlock = codeBlockMatchesBefore && codeBlockMatchesBefore.length % 2 !== 0;

        // Hard cap: never extend a chunk beyond 4x targetSize (min 2000 chars) for code blocks.
        // A very large code block (e.g. a package compatibility table) can otherwise
        // produce chunks of 12000+ tokens that OOM the embedding model at inference time.
        const MAX_CHUNK_CHARS = Math.max(this.targetSize * 4, 2000);

        if (startsInCodeBlock) {
          const nextEnd = text.indexOf('```', start);
          if (nextEnd !== -1 && nextEnd + 3 - start <= MAX_CHUNK_CHARS) {
            end = nextEnd + 3;
            slice = text.slice(start, end);
            extendedForCodeBlock = true;
            codeBlockExtensions++;
          }
        } else {
          const codeBlockMatchesInSlice = slice.match(/```/g);
          if (codeBlockMatchesInSlice && codeBlockMatchesInSlice.length % 2 !== 0) {
            const nextEnd = text.indexOf('```', start + slice.lastIndexOf('```') + 3);
            if (nextEnd !== -1 && nextEnd + 3 - start <= MAX_CHUNK_CHARS) {
              end = nextEnd + 3;
              slice = text.slice(start, end);
              extendedForCodeBlock = true;
              codeBlockExtensions++;
            }
          }
        }

        if (end < text.length && !extendedForCodeBlock) {
          const lastHeading = slice.lastIndexOf('\n#');
          if (lastHeading !== -1 && lastHeading > this.targetSize * 0.4) {
            end = start + lastHeading + 1;
            headingExtensions++;
          } else {
            const sentenceMatches = [...slice.matchAll(/[.!?](?=\s|\n)/g)];
            let lastSentencePos = -1;
            if (sentenceMatches.length > 0) {
              const lastMatch = sentenceMatches[sentenceMatches.length - 1];
              if (lastMatch && lastMatch.index !== undefined) {
                lastSentencePos = lastMatch.index + 1;
              }
            }

            if (lastSentencePos !== -1 && lastSentencePos > this.targetSize * 0.6) {
              end = start + lastSentencePos;
              sentenceExtensions++;
            } else {
              const lastNL = slice.lastIndexOf('\n');
              if (lastNL !== -1 && lastNL > this.targetSize * 0.7) {
                end = start + lastNL + 1;
                newlineExtensions++;
              } else {
                const lastSpace = slice.lastIndexOf(' ');
                if (lastSpace !== -1 && lastSpace > this.targetSize * 0.8) {
                  end = start + lastSpace + 1;
                  spaceExtensions++;
                }
              }
            }
          }
        }
      } else {
        end = text.length;
      }

      if (end <= start) end = Math.min(start + this.targetSize, text.length);

      const chunkText = text.slice(start, end);
      const actual_overlap = chunks.length === 0 ? 0 : Math.max(0, Math.min(chunkText.length, prevEnd - start));
      
      chunks.push({ text: chunkText, actual_overlap });
      
      if (end >= text.length) break;
      
      prevEnd = Math.max(prevEnd, end);
      start = end - this.overlap;
      if (start <= (end - chunkText.length)) {
        start = end - Math.min(this.overlap, chunkText.length - 1);
      }
      if (start < 0) start = 0;
      if (start >= end) start = end - 1; 
    }

    const duration = Date.now() - startTime;
    metrics.observe('chunker_duration_ms', duration);
    metrics.increment('chunker_operations_total', 1, { status: 'success' });
    metrics.increment('chunker_chunks_generated_total', chunks.length);
    metrics.increment('chunker_extensions_total', codeBlockExtensions, { type: 'code_block' });
    metrics.increment('chunker_extensions_total', headingExtensions, { type: 'heading' });
    metrics.increment('chunker_extensions_total', sentenceExtensions, { type: 'sentence' });
    metrics.increment('chunker_extensions_total', newlineExtensions, { type: 'newline' });
    metrics.increment('chunker_extensions_total', spaceExtensions, { type: 'space' });

    // Track chunk size distribution
    for (const chunk of chunks) {
      metrics.observe('chunker_chunk_size_chars', chunk.text.length);
      if (chunk.actual_overlap > 0) {
        metrics.observe('chunker_overlap_chars', chunk.actual_overlap);
      }
    }

    return chunks;
  }
}