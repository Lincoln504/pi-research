/**
 * Agent class that uses the agent-loop directly.
 * No transport abstraction - calls streamSimple via the loop.
 */
import { type ImageContent, type Message, type Model, type SimpleStreamOptions, type ThinkingBudgets, type Transport } from "@mariozechner/pi-ai";
import type { AfterToolCallContext, AfterToolCallResult, AgentEvent, AgentMessage, AgentState, AgentTool, BeforeToolCallContext, BeforeToolCallResult, StreamFn, ThinkingLevel, ToolExecutionMode } from "./types.js";
export interface AgentOptions {
    initialState?: Partial<AgentState>;
    /**
     * Converts AgentMessage[] to LLM-compatible Message[] before each LLM call.
     * Default filters to user/assistant/toolResult and converts attachments.
     */
    convertToLlm?: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
    /**
     * Optional transform applied to context before convertToLlm.
     * Use for context pruning, injecting external context, etc.
     */
    transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;
    /**
     * Steering mode: "all" = send all steering messages at once, "one-at-a-time" = one per turn
     */
    steeringMode?: "all" | "one-at-a-time";
    /**
     * Follow-up mode: "all" = send all follow-up messages at once, "one-at-a-time" = one per turn
     */
    followUpMode?: "all" | "one-at-a-time";
    /**
     * Custom stream function (for proxy backends, etc.). Default uses streamSimple.
     */
    streamFn?: StreamFn;
    /**
     * Optional session identifier forwarded to LLM providers.
     * Used by providers that support session-based caching (e.g., OpenAI Codex).
     */
    sessionId?: string;
    /**
     * Resolves an API key dynamically for each LLM call.
     * Useful for expiring tokens (e.g., GitHub Copilot OAuth).
     */
    getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
    /**
     * Inspect or replace provider payloads before they are sent.
     */
    onPayload?: SimpleStreamOptions["onPayload"];
    /**
     * Custom token budgets for thinking levels (token-based providers only).
     */
    thinkingBudgets?: ThinkingBudgets;
    /**
     * Preferred transport for providers that support multiple transports.
     */
    transport?: Transport;
    /**
     * Maximum delay in milliseconds to wait for a retry when the server requests a long wait.
     * If the server's requested delay exceeds this value, the request fails immediately,
     * allowing higher-level retry logic to handle it with user visibility.
     * Default: 60000 (60 seconds). Set to 0 to disable the cap.
     */
    maxRetryDelayMs?: number;
    /** Tool execution mode. Default: "parallel" */
    toolExecution?: ToolExecutionMode;
    /** Called before a tool is executed, after arguments have been validated. */
    beforeToolCall?: (context: BeforeToolCallContext, signal?: AbortSignal) => Promise<BeforeToolCallResult | undefined>;
    /** Called after a tool finishes executing, before final tool events are emitted. */
    afterToolCall?: (context: AfterToolCallContext, signal?: AbortSignal) => Promise<AfterToolCallResult | undefined>;
}
export declare class Agent {
    private _state;
    private listeners;
    private abortController?;
    private convertToLlm;
    private transformContext?;
    private steeringQueue;
    private followUpQueue;
    private steeringMode;
    private followUpMode;
    streamFn: StreamFn;
    private _sessionId?;
    getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
    private _onPayload?;
    private runningPrompt?;
    private resolveRunningPrompt?;
    private _thinkingBudgets?;
    private _transport;
    private _maxRetryDelayMs?;
    private _toolExecution;
    private _beforeToolCall?;
    private _afterToolCall?;
    constructor(opts?: AgentOptions);
    /**
     * Get the current session ID used for provider caching.
     */
    get sessionId(): string | undefined;
    /**
     * Set the session ID for provider caching.
     * Call this when switching sessions (new session, branch, resume).
     */
    set sessionId(value: string | undefined);
    /**
     * Get the current thinking budgets.
     */
    get thinkingBudgets(): ThinkingBudgets | undefined;
    /**
     * Set custom thinking budgets for token-based providers.
     */
    set thinkingBudgets(value: ThinkingBudgets | undefined);
    /**
     * Get the current preferred transport.
     */
    get transport(): Transport;
    /**
     * Set the preferred transport.
     */
    setTransport(value: Transport): void;
    /**
     * Get the current max retry delay in milliseconds.
     */
    get maxRetryDelayMs(): number | undefined;
    /**
     * Set the maximum delay to wait for server-requested retries.
     * Set to 0 to disable the cap.
     */
    set maxRetryDelayMs(value: number | undefined);
    get toolExecution(): ToolExecutionMode;
    setToolExecution(value: ToolExecutionMode): void;
    setBeforeToolCall(value: ((context: BeforeToolCallContext, signal?: AbortSignal) => Promise<BeforeToolCallResult | undefined>) | undefined): void;
    setAfterToolCall(value: ((context: AfterToolCallContext, signal?: AbortSignal) => Promise<AfterToolCallResult | undefined>) | undefined): void;
    get state(): AgentState;
    subscribe(fn: (e: AgentEvent) => void): () => void;
    setSystemPrompt(v: string): void;
    setModel(m: Model<any>): void;
    setThinkingLevel(l: ThinkingLevel): void;
    setSteeringMode(mode: "all" | "one-at-a-time"): void;
    getSteeringMode(): "all" | "one-at-a-time";
    setFollowUpMode(mode: "all" | "one-at-a-time"): void;
    getFollowUpMode(): "all" | "one-at-a-time";
    setTools(t: AgentTool<any>[]): void;
    replaceMessages(ms: AgentMessage[]): void;
    appendMessage(m: AgentMessage): void;
    /**
     * Queue a steering message while the agent is running.
     * Delivered after the current assistant turn finishes executing its tool calls,
     * before the next LLM call.
     */
    steer(m: AgentMessage): void;
    /**
     * Queue a follow-up message to be processed after the agent finishes.
     * Delivered only when agent has no more tool calls or steering messages.
     */
    followUp(m: AgentMessage): void;
    clearSteeringQueue(): void;
    clearFollowUpQueue(): void;
    clearAllQueues(): void;
    hasQueuedMessages(): boolean;
    private dequeueSteeringMessages;
    private dequeueFollowUpMessages;
    clearMessages(): void;
    /** The current abort signal, or undefined when the agent is not streaming. */
    get signal(): AbortSignal | undefined;
    abort(): void;
    waitForIdle(): Promise<void>;
    reset(): void;
    /** Send a prompt with an AgentMessage */
    prompt(message: AgentMessage | AgentMessage[]): Promise<void>;
    prompt(input: string, images?: ImageContent[]): Promise<void>;
    /**
     * Continue from current context (used for retries and resuming queued messages).
     */
    continue(): Promise<void>;
    private _processLoopEvent;
    private _runLoop;
    private emit;
}
//# sourceMappingURL=agent.d.ts.map