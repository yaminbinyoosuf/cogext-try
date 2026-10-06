export interface ToolResult {
    status: 'success' | 'failure';
    body: Record<string, unknown>;
    http_status: number;
}
export declare function sendEmail(to: string, subject: string): ToolResult;
export declare function writeFile(path: string, content: string): ToolResult;
export declare function updateDb(table: string, id: string, fields: Record<string, unknown>): ToolResult;
export declare function postSlack(channel: string, message: string): ToolResult;
