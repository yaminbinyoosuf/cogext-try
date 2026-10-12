# cogext-try

MCP observer that catches AI agents lying about tool success.

Run one command. Add one line to your agent config. Watch your agent
claim success on a tool that failed.

## Install

npx cogext-try --install

Prints the MCP config block to paste into Claude Code.

## What it does

Provides four fake tools: send_email, write_file, update_db,
post_slack. Roughly 40% of calls return a failure body inside a
200 OK.

When your agent claims success on a failed tool, the observer prints
a mismatch frame and streams the session to cogextai.com/live/<id>.

## Live page

On startup cogext-try creates a session on the COGEXT API and receives a
write token for it. The token stays in memory and is never printed or put
in a URL. Every tool call is sent with it.

The live page is unlisted, not private: anyone with the link can view it.
Set COGEXT_TRY_LOCAL=1 to send nothing at all.

If the API does not issue a token (for example an older self-hosted API set
through COGEXT_API_BASE), cogext-try prints why and stops streaming for that
run. It never sends events without a token.

## Publish

Publishing to cogextai.com/square is off by default. To turn it on, set
COGEXT_TRY_PUBLISH=1 in the MCP server's environment:

    "env": { "COGEXT_TRY_PUBLISH": "1" }

The session is then published once, after the API has accepted the first
caught failure. Only the process that created a session holds its token, so
publish from cogext-try rather than from the live page.

## Environment

- COGEXT_TRY_PUBLISH=1  publish the session to the Square after the first catch
- COGEXT_TRY_LOCAL=1    stream nothing; local frames only
- COGEXT_API_BASE       API base URL, default https://api.cogextai.com/api/v1

## Upgrading from 0.1.0

0.1.0 sends no session token, so the API rejects its events and its live
page stays empty. Update to 0.1.1 or later.

## Limit

This uses fake tools. It is a demo. The real observer
(cogext-observe) wraps your real tools.

## License

MIT
