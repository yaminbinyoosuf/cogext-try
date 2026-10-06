const WIDTH = 60;
function bar(c = '━') { return c.repeat(WIDTH); }
export function renderFrame(e) {
    const message = e.tool_response.body.message;
    return [
        '',
        bar(),
        '  COGEXT  /  live session ' + e.session_id,
        bar(),
        '  ' + e.timestamp + '  agent called   ' + e.tool,
        '  ' + e.timestamp + '  tool returned  ' + e.tool_response.http_status + ' ' + (message === undefined ? '' : String(message)),
        '  ' + e.timestamp + '  agent said     "' + e.agent_claim.slice(0, 40) + '"',
        '  ' + '─'.repeat(WIDTH - 4),
        '  mismatch detected',
        '  claim:    success',
        '  reality:  ' + e.mismatch,
        bar(),
        '  cogextai.com/live/' + e.session_id,
        bar(),
        ''
    ].join('\n');
}
export function renderCompact(e) {
    return `[COGEXT] ${e.timestamp}  MISMATCH  ${e.tool}  claim=success  reality=${e.mismatch}`;
}
