export interface Chunk {
  text: string;
  actual_overlap: number;
}

export interface ChunkerOptions {
  targetSize: number;
  overlap: number;
}

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
    if (!text) return [];

    const chunks: Chunk[] = [];
    let start = 0;
    let prevEnd = 0;

    while (start < text.length) {
      let end = start + this.targetSize;
      
      if (end < text.length) {
        let slice = text.slice(start, end);
        let extendedForCodeBlock = false;
        
        // 0. Code blocks atomicity
        const textBefore = text.slice(0, start);
        const codeBlockMatchesBefore = textBefore.match(/```/g);
        const startsInCodeBlock = codeBlockMatchesBefore && codeBlockMatchesBefore.length % 2 !== 0;

        if (startsInCodeBlock) {
          const nextEnd = text.indexOf('```', start);
          if (nextEnd !== -1) {
            end = nextEnd + 3;
            slice = text.slice(start, end);
            extendedForCodeBlock = true;
          }
        } else {
          const codeBlockMatchesInSlice = slice.match(/```/g);
          if (codeBlockMatchesInSlice && codeBlockMatchesInSlice.length % 2 !== 0) {
            const nextEnd = text.indexOf('```', start + slice.lastIndexOf('```') + 1);
            if (nextEnd !== -1) {
              end = nextEnd + 3;
              slice = text.slice(start, end);
              extendedForCodeBlock = true;
            }
          }
        }

        if (end < text.length && !extendedForCodeBlock) {
          const lastHeading = slice.lastIndexOf('\n#');
          if (lastHeading !== -1 && lastHeading > this.targetSize * 0.4) {
            end = start + lastHeading + 1;
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
            } else {
              const lastNL = slice.lastIndexOf('\n');
              if (lastNL !== -1 && lastNL > this.targetSize * 0.7) {
                end = start + lastNL + 1;
              } else {
                const lastSpace = slice.lastIndexOf(' ');
                if (lastSpace !== -1 && lastSpace > this.targetSize * 0.8) {
                  end = start + lastSpace + 1;
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
      const actual_overlap = chunks.length === 0 ? 0 : Math.max(0, prevEnd - start);
      
      chunks.push({ text: chunkText, actual_overlap });
      
      if (end >= text.length) break;
      
      prevEnd = end;
      start = end - this.overlap;
      if (start <= (end - chunkText.length)) {
        start = end - Math.min(this.overlap, chunkText.length - 1);
      }
      if (start < 0) start = 0;
      if (start >= end) start = end - 1; 
    }

    return chunks;
  }
}
