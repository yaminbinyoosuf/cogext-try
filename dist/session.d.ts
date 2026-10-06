export declare function getSessionId(): string;
export declare function getLiveUrl(): string;
export declare function createSession(): Promise<void>;
export declare function logEvent(event: Record<string, unknown>): Promise<void>;
