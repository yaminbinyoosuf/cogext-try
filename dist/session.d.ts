export interface LiveClientOptions {
    apiBase: string;
    local: boolean;
    publish: boolean;
    fetch?: typeof fetch;
    log?: (line: string) => void;
    newSessionId?: () => string;
    timeoutMs?: number;
}
export interface LogEventOptions {
    catch?: boolean;
}
export declare function createLiveClient(opts: LiveClientOptions): {
    getSessionId: () => string;
    getLiveUrl: () => string;
    createSession: () => Promise<void>;
    logEvent: (event: Record<string, unknown>, options?: LogEventOptions) => Promise<void>;
    publishIfEnabled: () => Promise<void>;
    isStreaming: () => boolean;
    isPublishEnabled: () => boolean;
};
export declare function getSessionId(): string;
export declare function getLiveUrl(): string;
export declare function createSession(): Promise<void>;
export declare function logEvent(event: Record<string, unknown>, options?: LogEventOptions): Promise<void>;
export declare function publishIfEnabled(): Promise<void>;
export declare function isStreaming(): boolean;
export declare function isPublishEnabled(): boolean;
