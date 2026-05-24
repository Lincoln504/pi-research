export interface StoreDocument {
  url: string;
  text: string;
  content?: string;
  metadata: Record<string, any>;
  timestamp: number;
}
