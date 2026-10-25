/**
 * Initial-coordinator model selection.
 *
 * Round 1 planning is the one research call that does NOT use the research model.
 * It uses the parent chat's model so the coordinator prompt shares a cache lineage
 * with the conversation that triggered the tool — same provider, same model, same
 * cached prefix. That is a real saving and stays the default.
 *
 * It is a bad default when the chat model is not a planner. Observed 2026-10-25 on
 * this host: the chat model was a local llama-swap server with one seat, and round-1
 * planning alone took 2m07s (4,886 tokens) while the hosted research model planned
 * the same query in seconds. A single-seat local server also refuses a concurrent
 * request from the owner, so a long coordinator call is felt by the user directly.
 * `PI_RESEARCH_COORDINATOR_MODEL=research` (or an explicit `provider/id`) opts out.
 *
 * Kept as a pure function (no registry, no config import) so the precedence is
 * testable without a live model registry; the caller supplies the lookup.
 */

export type CoordinatorModelChoice =
  /** `host` / unset — the chat's model (default). */
  | { kind: 'host' }
  /** `research` — the research model, same as rounds 2+. */
  | { kind: 'research' }
  /** An explicit model reference the caller must resolve. */
  | { kind: 'explicit'; reference: string };

/** Parse the configured value into a choice. Unset/blank → host. */
export function parseCoordinatorModelChoice(value: string | undefined | null): CoordinatorModelChoice {
  const raw = (value ?? '').trim();
  if (raw === '' || raw.toLowerCase() === 'host') return { kind: 'host' };
  if (raw.toLowerCase() === 'research') return { kind: 'research' };
  return { kind: 'explicit', reference: raw };
}

export interface ResolveCoordinatorModelOptions<M> {
  /** Raw `COORDINATOR_MODEL` setting. */
  readonly setting: string | undefined;
  /** The parent chat's model (`ctx.model`). */
  readonly hostModel: M | undefined;
  /** The resolved research model. */
  readonly researchModel: M;
  /** Look up an explicit model reference; return undefined when unknown. */
  readonly findByReference?: (reference: string) => M | undefined;
  /** Called when an explicit reference cannot be resolved (for a warning). */
  readonly onUnresolved?: (reference: string) => void;
}

/**
 * Pick the model for round-1 planning.
 *
 * An explicit reference that cannot be resolved falls back to the research model,
 * NOT to the host model: the user asked to stop planning on the host model, so a
 * typo must not silently restore it. (The opposite would be a trap — the config
 * looks applied while the behaviour is the one it was meant to change.)
 */
export function resolveCoordinatorModel<M>(
  options: ResolveCoordinatorModelOptions<M>,
): M {
  const { setting, hostModel, researchModel, findByReference, onUnresolved } = options;
  const choice = parseCoordinatorModelChoice(setting);
  switch (choice.kind) {
    case 'research':
      return researchModel;
    case 'explicit': {
      const found = findByReference?.(choice.reference);
      if (found) return found;
      onUnresolved?.(choice.reference);
      return researchModel;
    }
    case 'host':
    default:
      return hostModel ?? researchModel;
  }
}

/**
 * Strict `provider/id` (or authed bare-id) lookup for an explicit reference.
 *
 * Deliberately NOT resolveResearchModel: that function falls back through
 * RESEARCH_MODEL and then to "the first available model", so it can never return
 * undefined. Using it as the existence check for COORDINATOR_MODEL meant a typo
 * silently ran on an arbitrary available model and the warning never fired.
 *
 * Returns undefined when the reference matches nothing.
 */
export function findModelByReference<M extends { provider: string; id: string }>(
  reference: string,
  models: readonly M[],
  available: readonly M[] = [],
): M | undefined {
  // An exact `provider/id` is unambiguous, but the registry can list the same pair twice
  // (a keyless OAuth-style entry next to an authed one), so prefer the entry that is
  // actually usable before falling back to the full list.
  const exact = available.find((m) => `${m.provider}/${m.id}` === reference)
    ?? models.find((m) => `${m.provider}/${m.id}` === reference);
  if (exact) return exact;
  // Bare id: prefer an entry whose provider actually has auth, mirroring
  // resolveResearchModel's matchById, so a keyless duplicate cannot win.
  const sameId = models.filter((m) => m.id === reference);
  if (sameId.length === 0) return undefined;
  const authed = new Set(available.map((m) => `${m.provider}/${m.id}`));
  return sameId.find((m) => authed.has(`${m.provider}/${m.id}`)) ?? sameId[0];
}
