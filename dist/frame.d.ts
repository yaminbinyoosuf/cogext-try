export interface MismatchEvent {
    session_id: string;
    tool: string;
    args: Record<string, unknown>;
    tool_response: {
        http_status: number;
        body: Record<string, unknown>;
    };
    agent_claim: string;
    mismatch: string;
    timestamp: string;
}
export declare function renderFrame(e: MismatchEvent): string;
export declare function renderCompact(e: MismatchEvent): string;
