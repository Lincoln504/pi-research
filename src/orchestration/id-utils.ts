/**
 * Researcher ID Utilities
 *
 * Abstracts hierarchical IDs (1.1, 1.2, 2.1) to sequential display numbers (1, 2, 3, 4)
 * for cleaner UI while maintaining internal structure.
 */

import type { SystemResearchState } from './swarm-types.ts';

/**
 * Get sequential display number for a researcher ID
 *
 * Maps internal hierarchical IDs to sequential display numbers:
 * - Round 1: 1.1 → 1, 1.2 → 2, 1.3 → 3
 * - Round 2: 2.1 → 4, 2.2 → 5, etc.
 * - Continue sequentially across all rounds
 */
export function getDisplayNumber(state: SystemResearchState, internalId: string): string {
  const aspects = Object.values(state.aspects).sort((a, b) => {
    const aParts = a.id.split('.');
    const bParts = b.id.split('.');
    const aRound = parseInt(aParts[0] ?? '0');
    const aNum = parseInt(aParts[1] ?? '0');
    const bRound = parseInt(bParts[0] ?? '0');
    const bNum = parseInt(bParts[1] ?? '0');

    if (aRound !== bRound) return aRound - bRound;
    return aNum - bNum;
  });

  const index = aspects.findIndex(a => a.id === internalId);
  return index >= 0 ? (index + 1).toString() : internalId;
}

/**
 * Get a researcher's role context
 *
 * Returns role information for a researcher:
 * - Number in this round (1, 2, 3)
 * - Total siblings in this round
 * - Current round
 */
export function getResearcherRoleContext(
  state: SystemResearchState,
  internalId: string
): {
  displayNumber: string;
  roundNumber: number;
  totalInRound: number;
  isLastInRound: boolean;
} {
  const parts = internalId.split('.');
  const round = parseInt(parts[0] ?? '0');
  const sibling = parseInt(parts[1] ?? '0');
  const roundAspects = Object.values(state.aspects).filter(a => a.id.startsWith(`${round}.`));

  return {
    displayNumber: getDisplayNumber(state, internalId),
    roundNumber: round,
    totalInRound: roundAspects.length,
    isLastInRound: sibling === roundAspects.length,
  };
}
