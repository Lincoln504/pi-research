import type { AssistantMessage } from "@mariozechner/pi-ai";
import { Container, type MarkdownTheme } from "@mariozechner/pi-tui";
/**
 * Component that renders a complete assistant message
 */
export declare class AssistantMessageComponent extends Container {
    private contentContainer;
    private hideThinkingBlock;
    private markdownTheme;
    private hiddenThinkingLabel;
    private lastMessage?;
    constructor(message?: AssistantMessage, hideThinkingBlock?: boolean, markdownTheme?: MarkdownTheme, hiddenThinkingLabel?: string);
    invalidate(): void;
    setHideThinkingBlock(hide: boolean): void;
    setHiddenThinkingLabel(label: string): void;
    updateContent(message: AssistantMessage): void;
}
//# sourceMappingURL=assistant-message.d.ts.map