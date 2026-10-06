#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { sendEmail, writeFile, updateDb, postSlack } from './tools.js';
import { renderFrame, renderCompact } from './frame.js';
import { createSession, logEvent, getSessionId, getLiveUrl } from './session.js';
import { extractClaim } from './observer.js';
const lastCalls = [];
const MAX_HISTORY = 20;
if (process.argv.includes('--install') || process.argv.includes('--help')) {
    process.stdout.write(`
Add to Claude Code MCP config. Either block works.

1. If you installed the command (npm install -g cogext-try):

{
  "mcpServers": {
    "cogext": {
      "command": "cogext-try"
    }
  }
}

2. With nothing installed, once the package is on npm:

{
  "mcpServers": {
    "cogext": {
      "command": "npx",
      "args": ["-y", "cogext-try"]
    }
  }
}

3. From a checkout, with no install at all:

{
  "mcpServers": {
    "cogext": {
      "command": "node",
      "args": ["<path to cogext-try>/dist/index.js"]
    }
  }
}

Then restart Claude Code. Ask it to send an email, write a file, update a row
or post to Slack, and watch this terminal for the mismatch frames.
`);
    process.exit(0);
}
const server = new Server({ name: 'cogext-try', version: '0.1.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
        { name: 'send_email', description: 'Send an email.', inputSchema: { type: 'object', properties: { to: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' } }, required: ['to', 'subject'] } },
        { name: 'write_file', description: 'Write a file.', inputSchema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } },
        { name: 'update_db', description: 'Update a DB row.', inputSchema: { type: 'object', properties: { table: { type: 'string' }, id: { type: 'string' }, fields: { type: 'object' } }, required: ['table', 'id', 'fields'] } },
        { name: 'post_slack', description: 'Post to Slack.', inputSchema: { type: 'object', properties: { channel: { type: 'string' }, message: { type: 'string' } }, required: ['channel', 'message'] } }
    ]
}));
/* The tools above fail roughly 40% of the time but still answer HTTP 200.
   Every failed call is printed as a catch so the developer sees the silent
   failure mode immediately, and the session is streamed to the live URL. */
function reportCatch(timestamp, tool, args, result) {
    const reason = result.body.message === undefined ? 'tool returned an error' : String(result.body.message);
    const event = {
        session_id: getSessionId(),
        tool,
        args,
        tool_response: { http_status: result.http_status, body: result.body },
        agent_claim: extractClaim('the agent reported this step completed successfully'),
        mismatch: reason,
        timestamp
    };
    process.stderr.write(renderFrame(event));
    process.stderr.write(renderCompact(event) + '\n');
}
server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name } = request.params;
    const args = (request.params.arguments ?? {});
    const timestamp = new Date().toISOString();
    let result;
    switch (name) {
        case 'send_email':
            result = sendEmail(args.to, args.subject);
            break;
        case 'write_file':
            result = writeFile(args.path, args.content);
            break;
        case 'update_db':
            result = updateDb(args.table, args.id, args.fields || {});
            break;
        case 'post_slack':
            result = postSlack(args.channel, args.message);
            break;
        default: throw new Error('Unknown tool: ' + name);
    }
    lastCalls.unshift({ tool: name, args, result, timestamp });
    if (lastCalls.length > MAX_HISTORY)
        lastCalls.pop();
    await logEvent({ kind: 'tool_call', tool: name, args, result, timestamp });
    if (result.status === 'failure')
        reportCatch(timestamp, name, args, result);
    return { content: [{ type: 'text', text: JSON.stringify(result.body) }] };
});
async function main() {
    await createSession();
    const transport = new StdioServerTransport();
    await server.connect(transport);
    process.stderr.write('\nCOGEXT-try observer running.\n');
    process.stderr.write('Session: ' + getSessionId() + '\n');
    process.stderr.write('Live URL: ' + getLiveUrl() + '\n\n');
}
main().catch((err) => {
    process.stderr.write('cogext-try failed: ' + err.message + '\n');
    process.exit(1);
});
