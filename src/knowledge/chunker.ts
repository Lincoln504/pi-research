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
      const iterationStart = start;
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

      // Forward-progress invariant: every chunk after the first must end past the
      // previous chunk's end. When the overlap step plants `start` inside a code
      // block whose closing fence terminated the PREVIOUS chunk, the in-block
      // re-extension above clamps `end` back onto that same fence — a chunk that
      // re-covers only overlap content, and (via the 1-char anti-regression step
      // below) one such sliver per character until `start` clears the fence.
      // Covering fresh text is worth splitting the fence: the previous chunk
      // already carries the block's tail intact.
      if (chunks.length > 0 && end <= prevEnd) {
        end = Math.min(start + this.targetSize, text.length);
      }

      // UTF-16 surrogate-pair safety: `end` is a raw code-unit index, and every
      // adjustment above (code-block/heading/sentence/newline/space, plus the
      // forward-progress guard) operates purely in code-unit space — none of
      // them are aware of astral characters (emoji, rare CJK Extension B+),
      // which are a HIGH surrogate (0xD800-0xDBFF) followed by a LOW surrogate
      // (0xDC00-0xDFFF). If `end` lands between the two halves, slicing here
      // emits a lone high surrogate. Node's UTF-16->UTF-8 conversion (JSON
      // serialization, HTTP bodies, N-API marshalling into the LanceDB/Arrow
      // layer) silently substitutes U+FFFD for that rather than throwing —
      // silent corruption of text that gets embedded and stored. Mirrors the
      // backoff in truncateWithMarker (src/utils/text-utils.ts). Applied last,
      // right before the slice, and only shrinks `end` when doing so can't
      // undo the forward-progress guard just above or produce an empty chunk.
      if (end < text.length) {
        const code = text.charCodeAt(end - 1);
        if (code >= 0xd800 && code <= 0xdbff) {
          const candidate = end - 1;
          const staysPastPrev = chunks.length === 0 || candidate > prevEnd;
          if (candidate > start && staysPastPrev) {
            end = candidate;
          } else {
            // Backing off would violate the forward-progress guard above (or empty
            // the chunk) — this happens when targetSize and overlap sit within one
            // code unit of each other. Grow past the low surrogate instead: taking
            // the full pair into THIS chunk only ever increases `end`, so it can
            // never re-collide with the guard it just failed, and it still avoids
            // splitting the pair (the alternative — leaving `end` right after the
            // lone high surrogate — is the silent corruption this block exists to
            // prevent).
            const low = text.charCodeAt(end);
            if (low >= 0xdc00 && low <= 0xdfff) {
              end = Math.min(end + 1, text.length);
            }
          }
        }
      }

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

      // Forward-progress invariant, start side: the constructor rejects
      // overlap >= targetSize specifically "to prevent infinite loops," but that
      // guarantee only holds for the raw arithmetic above — it says nothing about
      // the end-side forward-progress guard earlier in this loop reusing the same
      // `end` two iterations in a row, which can leave `start` no greater than the
      // value this same iteration started with, reproducing an identical chunk
      // forever (observed: OOM from an unbounded chunks array on a small
      // targetSize/overlap gap plus a boundary emoji). Guarantee real progress
      // independent of every heuristic above, mirroring the `end`-side guard.
      // Applied BEFORE the surrogate-pair check below so that check always
      // adjusts an already-safe value instead of being able to undo this guard.
      if (start <= iterationStart) start = iterationStart + 1;

      // Surrogate-pair safety, read side: `start` (end - overlap, further
      // clamped above) is an independent raw code-unit index — it is not
      // derived from any of the textual heuristics that picked `end` above,
      // so the fix to `end` does not cover it. It can separately bisect an
      // unrelated pair and produce a next chunk that OPENS with a lone low
      // surrogate. The pair's high half is already inside the chunk just
      // pushed (it sits before `end`), so pulling `start` back one unit only
      // widens that chunk's overlap by one code unit — it never drops text.
      // Only pull back when doing so keeps the forward-progress guard above
      // satisfied; otherwise push forward past the low surrogate instead — the
      // pair's high half is guaranteed already present in the chunk just
      // pushed, so skipping the low half here loses nothing, it just narrows
      // this chunk's overlap by one code unit instead of widening it.
      if (start > 0) {
        const code = text.charCodeAt(start);
        if (code >= 0xdc00 && code <= 0xdfff) {
          if (start - 1 > iterationStart) {
            start -= 1;
          } else if (start + 1 < end) {
            start += 1;
          }
        }
      }
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