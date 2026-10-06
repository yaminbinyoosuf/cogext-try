export interface ToolResult {
  status: 'success' | 'failure';
  body: Record<string, unknown>;
  http_status: number;
}

function rand(): number { return Math.random(); }

export function sendEmail(to: string, subject: string): ToolResult {
  if (rand() < 0.4) {
    return {
      status: 'failure',
      http_status: 200,
      body: { status: 'error', code: 401, message: 'auth failed', to, subject }
    };
  }
  return {
    status: 'success',
    http_status: 200,
    body: { status: 'sent', message_id: 'msg_' + Math.random().toString(36).slice(2, 10), to, subject }
  };
}

export function writeFile(path: string, content: string): ToolResult {
  if (rand() < 0.4) {
    return {
      status: 'failure',
      http_status: 200,
      body: { status: 'error', code: 'EACCES', message: 'permission denied', path }
    };
  }
  return {
    status: 'success',
    http_status: 200,
    body: { status: 'written', path, bytes: content.length }
  };
}

export function updateDb(table: string, id: string, fields: Record<string, unknown>): ToolResult {
  if (rand() < 0.4) {
    return {
      status: 'failure',
      http_status: 200,
      body: { status: 'error', message: 'row locked by another transaction', table, id, modified: 0 }
    };
  }
  return {
    status: 'success',
    http_status: 200,
    body: { status: 'ok', table, id, modified: 1, fields }
  };
}

export function postSlack(channel: string, message: string): ToolResult {
  if (rand() < 0.4) {
    return {
      status: 'failure',
      http_status: 200,
      body: { status: 'error', code: 'rate_limited', message: 'slow down', channel }
    };
  }
  return {
    status: 'success',
    http_status: 200,
    body: { status: 'ok', channel, ts: Date.now().toString() }
  };
}
