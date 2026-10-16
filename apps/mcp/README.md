# Workloom local MCP

This local synthetic pilot exposes seven reads and two guarded task writes. It has no database connection, remote MCP HTTP listener, OAuth or private-ACL claim. The API remains the authorization boundary and rechecks credential expiry, revocation, scopes and current membership for every list/call. Task writes use the existing commands and workspace transaction barrier.

Build with the repository's Node24 setup before connecting a client. Start the API separately and verify `/healthz/ready`. Launch the compiled MCP entry directly; an npm banner would corrupt protocol stdout.

Example client configuration (edit your own client only when you choose to connect):

```json
{
  "mcpServers": {
    "workloom-local": {
      "command": "/Users/pavelignatov/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node",
      "args": ["/Volumes/PavelData/ai/workloom/apps/mcp/dist/main.js"],
      "env": {
        "APP_ENV": "local",
        "WORKLOOM_MCP_API_URL": "http://127.0.0.1:4310/",
        "WORKLOOM_MCP_TOKEN": "<your copy-once Workloom local credential>"
      }
    }
  }
}
```

The command and script must be absolute paths on your machine. The placeholder is intentionally not a valid token. Issue a self-owned credential in Workspace → Integrations with only needed scopes. No write scopes are preselected. Keep the token out of argv, source code, URLs and logs; use the client's protected process environment/config facility. Lost browser secret cannot be recovered: revoke that credential and issue another. `DATABASE_URL` is neither required nor read. No client configuration is edited automatically.

Read tools: `list_projects`, `get_project`, `search_tasks`, `get_task`, `list_memberships`, `get_field_definitions`, `get_task_field_values`. Write tools: `create_task`, `update_task`, only when current credential scopes and current role permit them. The live catalog is checked on each `tools/list`; saved tool descriptions never authorize a call. Modern2026-07-28 and legacy initialize use the same `serveStdio` factory.

Every write requires caller-held `operationKey` and the shared strict input/revision guards. If a dispatched write times out, loses its response, returns invalid data or fails with5xx, the tool explicitly reports `outcome:"unknown"`: the server may have committed it. Repeat **the exact original call and operationKey**. Do not create a new key or silently change the input. There are no automatic retries. Controlled4xx rejection is reported separately.

Only fixed loopback HTTP paths are used: redirects fail, cookies are omitted, timeout is10s and streamed responses are capped at2MiB. Nonpaged list bounds fail explicitly rather than truncate. stdout contains protocol JSON only; sanitized diagnostics go to stderr. EOF/SIGINT/SIGTERM abort pending HTTP and close the transport. API request correlation is returned in `_meta["workloom/requestId"]`.

See [the precise contract and acceptance boundaries](../../docs/20-p5b-mcp-contract.md). Unit/in-memory SDK success is separate from real subprocess, PostgreSQL, browser and old-client checks; production deployment and Auth remain outside this slice.
