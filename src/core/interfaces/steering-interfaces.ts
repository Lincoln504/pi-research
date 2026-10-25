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
 *
 * A popped message can additionally be FORWARDED to pi (Alt+P hands it to pi's own
 * steering queue). That is tracked separately (forwardedToPiAt) rather than as a
 * fourth status: once forwarded, the message has left this extension's control —
 * pi owns delivery — and the only remaining question is whether pi still holds it
 * un-delivered, which decides whether Esc may cancel pi's agent turn.
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
  /**
   * Timestamp when a popped message was successfully handed to pi's own steering
   * queue (Alt+P). null while it is not, and on every non-popped message.
   */
  forwardedToPiAt: number | null;
}
