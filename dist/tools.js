function rand() { return Math.random(); }
export function sendEmail(to, subject) {
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
export function writeFile(path, content) {
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
export function updateDb(table, id, fields) {
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
export function postSlack(channel, message) {
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
