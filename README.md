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
a mismatch frame and streams the catch to cogextai.com/live/<id>.

## Share

Every catch gets a shareable URL. Publish to cogextai.com/square.

## Limit

This uses fake tools. It is a demo. The real observer
(cogext-observe) wraps your real tools.

## License

MIT
