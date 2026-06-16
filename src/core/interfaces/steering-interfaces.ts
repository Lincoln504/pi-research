/**
 * Steering Message Contracts
 *
 * Pure data types for user steering messages captured during active research.
 * Lives in core/ (the bottom layer) so core interfaces and orchestration code
 * can both reference it without violating layer boundaries.
 */

/**
 * Steering message status lifecycle:
 * queued → active (consumed by orchestrator) or queued → popped (removed by user via Alt+P)
 */
export type SteeringMessageStatus = 'queued' | 'active' | 'popped';

/**
 * A steering message captured during active research.
 */
export interface SteeringMessage {
  /** Unique identifier */
  id: string;
  /** The message text */
  text: string;
  /** Current lifecycle status */
  status: SteeringMessageStatus;
  /** Timestamp when the message was added */
  addedAt: number;
  /** Timestamp when the message was consumed (marked active) by the orchestrator */
  consumedAt: number | null;
  /** Timestamp when the message was popped by the user */
  poppedAt: number | null;
}
