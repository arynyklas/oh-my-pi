# Auth Broker and Auth Gateway

The auth broker and auth gateway are two cooperating HTTP services that move OAuth refresh tokens and provider access tokens off developer laptops and into a single broker host.

- **`omp auth-broker serve`** holds the canonical SQLite credential vault, performs OAuth refreshes, and exposes a small REST API (`/v1/snapshot`, `/v1/snapshot/stream`, `/v1/credential/:id/refresh`, `/v1/credential/:id/disable`, `/v1/credential`, `/v1/usage`, `/v1/healthz`).
- **`omp auth-gateway serve`** is a forward-proxy. It accepts OpenAI Chat Completions, Anthropic Messages, OpenAI Responses, and pi-native stream requests, resolves the broker-backed credential, and dispatches through `pi-ai` provider logic. Clients (containerised omp, llm-git, the macOS usage widget, …) never see the access token.

Transport security between operator, broker, and gateway is delegated to the operator (Tailscale / Wireguard / reverse proxy + TLS). Every endpoint except `/v1/healthz` (broker) and `/healthz` (gateway) requires a bearer token.

Source: `packages/ai/src/auth-broker/`, `packages/ai/src/auth-gateway/`, `packages/coding-agent/src/cli/auth-broker-cli.ts`, `packages/coding-agent/src/cli/auth-gateway-cli.ts`, `packages/coding-agent/src/session/auth-broker-config.ts`.

## Data flow

```
                ┌────────────────────────────────────────────────────────────┐
                │ broker host                                                │
                │                                                            │
  developer ──▶ │  ┌──────────────────────────┐    ┌────────────────────┐    │
  laptop /      │  │  omp auth-broker serve   │◀──▶│  SQLite agent.db    │    │
  CI / robomp   │  │  - holds refresh tokens  │    │  (canonical writer)│    │
                │  │  - background refresher  │    └────────────────────┘    │
                │  │  /v1/{snapshot,refresh,…}│                              │
                │  └─────────┬────────────────┘                              │
                │            │  bearer ($CONFIG_DIR/auth-broker.token)       │
                │            ▼                                               │
                │  ┌──────────────────────────┐                              │
                │  │  omp auth-gateway serve  │  RemoteAuthCredentialStore   │
                │  │  /v1/{chat,messages,…}   │  receives snapshot stream,   │
                │  │  /v1/usage,/v1/models    │  refreshes credentials by id │
                │  │  /v1/credentials/check   │  via the broker on expiry    │
                │  └─────────┬────────────────┘                              │
                └────────────┼───────────────────────────────────────────────┘
                             │  bearer ($CONFIG_DIR/auth-gateway.token)
                             ▼
                  gateway clients
                  (llm-git, macOS widget, robomp containers, IDE plugins, …)
                                │
                                ▼ provider request with broker-resolved credential
                  api.anthropic.com / api.openai.com / …
```

The broker is the only writer of OAuth refresh tokens. Clients (including the gateway itself) load a redacted snapshot in which every `refresh` field has been replaced with `REMOTE_REFRESH_SENTINEL`; when an access token expires the client calls `POST /v1/credential/:id/refresh` and the broker performs the refresh server-side. `RemoteAuthCredentialStore` rejects local replace/upsert/delete-by-provider mutations, with errors pointing at `omp auth-broker login` / `omp auth-broker logout`.

## auth-broker

### CLI

```
omp auth-broker serve     [--bind=host:port]                    # boot the broker
omp auth-broker token     [--regenerate] [--json]               # print or rotate the bearer token
omp auth-broker login     [<provider>] [--via=user@host] [--dry-run]
omp auth-broker logout    [<provider>]
omp auth-broker list      [--json]
omp auth-broker import    <file|dir> [--provider=<id>] [--include-disabled] [--dry-run] [--json]
omp auth-broker migrate   --from-local [--include-oauth] [--include-env] [--dry-run] [--json]
omp auth-broker status    [--json]
```

- `serve` opens the local SQLite store at `getAgentDbPath()` and binds an HTTP listener (default `127.0.0.1:8765`). On startup a token is ensured at `<config-dir>/auth-broker.token` (mode `0600`, `0700` parent dir). The background refresher refreshes any OAuth credential whose `expires - Date.now() < refreshSkewMs` (default 5 min) every `refreshIntervalMs` (default 60 s).
- `token` prints the cached bearer or generates a new one. `--regenerate` rotates it.
- `login [<provider>]` runs the per-provider OAuth flow locally — when no provider is supplied, it falls back to an interactive numbered picker. With `--via=user@host` it shells out `ssh -L <callback-port>:127.0.0.1:<callback-port> user@host omp auth-broker login <provider>` so the OAuth callback hits the local browser but the credential is written on the broker host (`--via` requires `<provider>`). Built-in callback ports: `anthropic:54545`, `openai-codex:1455`, `google-gemini-cli:8085`, `google-antigravity:51121`, `gitlab-duo:8080`. The OAuth dance is driven in-process via `AuthStorage.login()` — there is no longer a `pi-ai` bin to spawn.
- `logout [<provider>]` deletes every credential row for `<provider>`. With no argument it shows an interactive numbered picker of currently-stored providers.
- `list` enumerates every registered OAuth provider id/name (the union of built-ins + `registerOAuthProvider` custom providers). `--json` emits a machine-readable array.
- `import <file|dir>` imports CLIProxyAPI-style JSON credentials into the local SQLite store. Maps `type` field → omp provider (`claude → anthropic`, `codex → openai-codex`, `gemini → google-gemini-cli`, `antigravity → google-antigravity`, `gemini-cli → google-gemini-cli`).
- `migrate --from-local` uploads local SQLite credentials to the configured broker (`POST /v1/credential`). Local API keys are included by default; local OAuth rows are skipped unless `--include-oauth` is set; environment-derived API keys are skipped unless `--include-env` is set. Re-runs are idempotent against the broker snapshot.
- `status` health-pings the configured remote broker.

### Endpoints

| Method | Path                         | Auth   | Purpose                                                 |
| ------ | ---------------------------- | ------ | ------------------------------------------------------- |
| `GET`  | `/v1/healthz`                | none   | Liveness + version                                      |
| `GET`  | `/v1/snapshot`               | bearer | Redacted snapshot (refresh tokens replaced by sentinel) |
| `GET`  | `/v1/snapshot/stream`        | bearer | SSE snapshot stream with delta events and keepalives    |
| `POST` | `/v1/credential`             | bearer | Upsert one OAuth or API-key credential                  |
| `POST` | `/v1/credential/:id/refresh` | bearer | Force-refresh one OAuth credential                      |
| `POST` | `/v1/credential/:id/disable` | bearer | Disable one credential with a recorded cause            |
| `GET`  | `/v1/usage`                  | bearer | Aggregate `UsageReport[]` across credentials            |

Requests use `Authorization: Bearer <token>`. The server compares against an in-memory token allow-list; the gateway’s implementation uses a timing-safe comparison.

### Background refresher

`AuthBrokerRefresher` iterates active OAuth credentials at `refreshIntervalMs` cadence and refreshes any within `refreshSkewMs` of expiry. Refreshes are single-flighted per credential id so a slow refresh cannot be retriggered. The refresher distinguishes:

- **definitive failures** (`invalid_grant`, `invalid_token`, `revoked`, unauthorized refresh-token, 401/403 not from a network blip) — credentials are passed to `AuthStorage.disableCredentialById(id, cause)` so the next snapshot pull surfaces a clean delete on the client;
- **transient failures** (timeout / ECONNREFUSED / fetch failed) — left in place for the next sweep.

## auth-gateway

### CLI

```
omp auth-gateway serve   [--bind=host:port] [--no-auth]
omp auth-gateway token   [--regenerate] [--json]
omp auth-gateway status  [--json]
omp auth-gateway check   [--strict] [--json]
omp auth-gateway tui     [--connection=<name>]

omp auth-gateway user create <name> [--description=] [--owner=] [--role=user|admin] [--label=] [--json]
omp auth-gateway user list [--json]
omp auth-gateway user show|enable|disable|delete <name-or-id> [--json]
omp auth-gateway user update <name-or-id> [--description=] [--owner=] [--role=] [--json]
omp auth-gateway user token <name-or-id> [--label=] [--regenerate] [--json]
omp auth-gateway user token-revoke <name-or-id> <token-id> [--json]
omp auth-gateway user allow|deny <name-or-id> (--provider= | --model= | --route=) [--json]
omp auth-gateway user acl <name-or-id> [--json]
omp auth-gateway user acl-delete <name-or-id> <rule-id> [--json]
omp auth-gateway user set-pool|unset-pool <name-or-id> <pool-name-or-id> [--json]
omp auth-gateway user reorder-pools <name-or-id> <pool-id,...> [--json]
omp auth-gateway user usage <name-or-id> [--since=<epoch-ms>] [--json]

omp auth-gateway pool create <name> [--strategy=sticky-session|least-used|round-robin|failover] [--json]
omp auth-gateway pool list [--json]
omp auth-gateway pool show|delete <name-or-id> [--json]
omp auth-gateway pool set-strategy <name-or-id> <strategy> [--json]
omp auth-gateway pool add-account|remove-account <name-or-id> <credential-id> [--json]
omp auth-gateway pool rename <name-or-id> <new-name> [--json]
omp auth-gateway audit list [--user=<name-or-id>] [--limit=<1..1000>] [--before=<event-id>] [--json]
```

- `serve` requires `OMP_AUTH_BROKER_URL` (or `auth.broker.url` in `config.yml`) — the gateway is itself a broker client. It calls `AuthBrokerClient.fetchSnapshot()`, wraps it in `RemoteAuthCredentialStore`, constructs an `AuthStorage` that resolves access tokens through the broker, and opens the gateway-local access database at `<config-dir>/auth-gateway.db` (`0600` in a `0700` parent dir). Default bind is `127.0.0.1:4000`. The legacy gateway token remains stored at `<config-dir>/auth-gateway.token` (`0600`); managed client tokens are accepted in addition to it. `--no-auth` disables bearer checks for inference/diagnostic routes but intentionally rejects remote HTTP management APIs.
- `token` / `status` manage and inspect the legacy gateway bearer token and upstream broker readiness. `status --json` also reports `accessDb`, `managedUserCount`, `activeManagedTokenCount`, and `poolCount`; a missing access DB reports zero managed counts without creating it.
- `check` probes broker-backed credentials through the gateway store. Without `--strict` it uses provider usage probes; `--strict` also exercises each credential against its chat-completion endpoint and can consume a small amount of quota. Managed regular users calling `/v1/credentials/check` receive only scoped, redacted pool-member health.
- `user`, `pool`, and `audit` manage gateway-local identities, independently rotatable managed tokens, ACLs, credential-pool bindings, per-user usage summaries, and newest-first audit rows. `user create`, `user token`, and `user token --regenerate` print the raw managed token once in human output and include `token.value` in JSON output; human `user show` includes redacted token ids/public ids, ACL rule ids, and pool bindings for revocation and deletion commands, while list/show output never includes raw token bytes, token hashes, broker OAuth refresh tokens, OAuth access tokens, provider API keys, account metadata, or project metadata.
- `tui` opens the remote operator console from the administrator's local omp install. It resolves a named user-scoped gateway connection (or the active connection when omitted), then connects over HTTPS with a managed admin token. Loopback development URLs may use `http://localhost`, `http://127.0.0.1`, or `http://[::1]`; every non-loopback hostname must use `https://`. There is no `--insecure`, broker-token prompt, plaintext-remote override, or local SQLite fallback.

### Endpoints

| Method | Path                    | Auth   | Purpose                                                      |
| ------ | ----------------------- | ------ | ------------------------------------------------------------ |
| `GET`  | `/healthz`              | none   | Liveness + version                                           |
| `GET`  | `/v1/usage`             | bearer | Aggregate `UsageReport[]` (proxied through `AuthStorage`)    |
| `GET`  | `/v1/models`            | bearer | Bundled-model catalog filtered to providers with credentials |
| `GET`  | `/v1/credentials/check` | bearer | Per-credential auth health probe                             |
| `POST` | `/v1/chat/completions`  | bearer | OpenAI Chat Completions wire format                          |
| `POST` | `/v1/messages`          | bearer | Anthropic Messages wire format                               |
| `POST` | `/v1/responses`         | bearer | OpenAI Responses wire format                                 |
| `POST` | `/v1/pi/stream`         | bearer | Native `pi-ai` stream wire format                            |

The model id is read from the top-level `model` field for foreign wire formats and from the pi-native request body for `/v1/pi/stream`. The gateway picks the first bundled `Model<Api>` matching that id, parses the inbound wire format into an omp `Context`, resolves the provider credential from broker-backed `AuthStorage`, dispatches through `streamSimple()`, and re-encodes the result to the inbound format (SSE for streamed responses).

There is no raw provider passthrough path. All supported routes go through `pi-ai` provider logic so credential-specific request shaping, OAuth refresh-on-auth-error, and provider quirks stay centralized.

`idleTimeout` on the underlying `Bun.serve` is set to `255 s` so long thinking-budget calls do not get killed by Bun’s default idle timeout.

### Managed users, ACLs, and pools

The gateway stores client identities, SHA-256 hashes of managed client tokens, ACL rules, pool definitions, user-pool bindings, and audit rows in `<config-dir>/auth-gateway.db`. Managed tokens are generated as `omp_gw_<publicId>.<secret>` and are shown only once by `user create`, `user token`, or `user token --regenerate`; list/show commands display redacted token identifiers and revoked/last-used state, and human `user show` also displays ACL rule ids and pool bindings. The broker remains the only owner of provider OAuth refresh tokens and uploaded provider API-key credential payloads.

Legacy `<config-dir>/auth-gateway.token` is a virtual full-admin identity for operational recovery. `--no-auth` is a virtual admin bypass for inference, `/v1/models`, `/v1/usage`, and `/v1/credentials/check`, but it cannot call HTTP management APIs; use the local CLI for management when `--no-auth` is active.

Regular managed users are default-deny. They need route allows for route-gated diagnostics (`usage`, `check`), and they need a provider or model ACL allow plus an ordered bound pool that contains at least one live account for the request provider before inference can dispatch. Deny rules win over allows. Provider ACL patterns are exact provider ids or `*`; model patterns are exact qualified ids (`provider/model`), `provider/*`, or `*`; route patterns are one gateway route (`chat`, `messages`, `responses`, `pi-native`, `models`, `usage`, `check`) or `*`. The console's **Basic routes** shortcut adds `chat`, `messages`, `responses`, `pi-native`, and `models` atomically; `usage` and `check` remain explicit. Route allows alone never grant provider/model access. Hidden known models, unknown model ids, ACL failures, and missing pool bindings all return the same managed-user `403 permission_error` response so model existence is not leaked.

Pools are provider-neutral ordered account groups. One pool can contain broker credentials from multiple providers, and one account can belong to multiple pools. A regular user's pool bindings are ordered; routing scans bindings by position and selects the first bound pool containing a live credential for the request provider, then applies that pool's strategy only to members for that provider. Reordering user bindings changes fallback precedence without editing pool membership. Strategies are:

- `sticky-session` — keep the session's eligible unblocked credential; otherwise use the existing deterministic session hash and usage-aware ordering.
- `least-used` — keep the eligible unblocked credential for an existing session; for a new or replacement session, rank OAuth members that have live usage and then fall back to unified configured order when no live OAuth usage is available.
- `round-robin` — assign new sessions from one counter scoped by pool/provider across matching-provider OAuth and API-key members while keeping existing eligible stickies.
- `failover` — follow configured matching-provider member order and advance only after block/auth/usage-limit failure.

Managed regular requests pass an `AuthStorage` selection policy containing only the selected pool's matching-provider credential ids. Initial resolution, force refresh, usage-limit handling, invalidation, and retries all receive the same policy, so no request can fall through to out-of-pool stored credentials, runtime overrides, config keys, env keys, or fallback resolvers. A user with no pool bindings gets the leak-resistant `403 permission_error`; a bound pool set with no live provider-matching member returns `503 no_eligible_credential`; an exhausted selected pool returns `429 rate_limit_error` with `Retry-After` when the upstream reset is known.

### Management and audit APIs

HTTP management routes require an authenticated legacy or managed admin token. They use JSON errors shaped as `{ "error": { "code": "...", "message": "..." } }`; validation errors are `400 invalid_request`, non-admins are `403 forbidden`, no-auth is `403 management_auth_required`, missing rows are `404 not_found`, and duplicate/conflicting rows are `409 conflict`.

| Method | Path | Purpose |
| ------ | ---- | ------- |
| `GET` / `POST` | `/v1/users` | List users; create user and one-time token |
| `GET` / `PATCH` / `DELETE` | `/v1/users/:id` | Show, update, or delete a user |
| `POST` / `DELETE` | `/v1/users/:id/tokens[/:tokenId]` | Add or revoke managed tokens |
| `POST` | `/v1/users/:id/tokens/rotate` | Revoke active tokens for one user and issue one replacement |
| `GET` / `POST` / `DELETE` | `/v1/users/:id/acl[/:ruleId]` | Manage provider/model/route ACL rules |
| `POST` | `/v1/users/:id/acl/batch` | Atomically add 1–64 ACL rules, including Basic route groups |
| `GET` / `POST` / `PATCH` / `DELETE` | `/v1/users/:id/pools[/:poolId]` | List, bind, reorder, or unbind ordered pool bindings |
| `GET` | `/v1/users/:id/usage?since=<ms>` | Return gateway audit usage for one user |
| `GET` / `POST` | `/v1/pools` | List or create provider-neutral pools |
| `GET` / `PATCH` / `DELETE` | `/v1/pools/:id` | Show, update name/strategy, or delete a pool |
| `POST` / `DELETE` | `/v1/pools/:id/members[/:credentialId]` | Add or remove broker credential ids |
| `PATCH` | `/v1/pools/:id/members` | Atomically replace the complete ordered credential-id membership |
| `GET` | `/v1/pools/:id/users` | List users bound to one pool |
| `GET` | `/v1/audit?userId=&limit=&before=` | Newest-first audit rows with an exclusive `before` id cursor |
| `GET` | `/v1/admin/status` | Remote console status, current principal, counts, and gateway version |
| `GET` / `POST` | `/v1/admin/credentials` | List redacted provider accounts; upload one locally-acquired credential |
| `POST` / `DELETE` | `/v1/admin/credentials/:id[/refresh]` | Refresh OAuth credentials or remove an unused account |

For managed regular users, `/v1/usage[?since=<ms>]` returns `{ usage: AuthGatewayUsageSummary }` aggregated from successful provider/model audit rows, not broker account-quota reports. Omitted `since` means `0`; non-finite or negative values return `400 invalid_request_error`; legacy, managed-admin, and `--no-auth` callers continue to receive broker quota reports. `/v1/credentials/check` returns response-local member ordinals, provider, type, `ok`, and coarse reason codes only; it omits broker credential ids, emails, account/project ids, provider payloads, upstream reason strings, headers, and raw metadata.

Audit rows snapshot request id, user id/name, token id, method, query-stripped pathname, route family, requested/resolved model, selected credential id, outcome, status, token counts, cost, and sanitized error code. They never persist URL query/search/hash, request bodies, headers, raw gateway tokens, provider API keys, OAuth access tokens, OAuth refresh tokens, raw upstream errors, account ids, project ids, or emails.

### Remote operator console

Remote administration is deliberately split between host-side bootstrap, local profile configuration, and live remote operations.

1. On the gateway host, create the first managed administrator token with `omp auth-gateway user create <name> --role=admin`. The raw managed bearer is shown once; copy it directly into the administrator client's profile wizard. The legacy `<config-dir>/auth-gateway.token` remains a recovery/bootstrap bearer, but normal operator profiles should use revocable managed-admin tokens.
2. On the administrator client, open `/settings` and select the **Gateway** tab to create or edit named connections only. The settings tab stores connection metadata in the active omp profile's `auth-gateways.json`, not in project `.omp` settings, and it never stores pasted bearer bytes in that JSON. Managed-file tokens live separately as `<connection>.token` files under the active profile's gateway-token directory with private file permissions; env sources store only the environment variable name; command sources store only the command reference. Profile URLs are normalized, reject URL credentials/query/hash, preserve a reverse-proxy path prefix, and reject non-loopback `http://` before any token source is read.
3. Open live administration with `/gateway [connection]` inside interactive omp or `omp auth-gateway tui --connection=<name>` from the CLI. Omitting the connection uses the active profile. If no connection exists, the same profile editor opens in onboarding mode and proceeds to the console only after authenticated status succeeds.

The console has five tabs and shared keys: `1`-`5` switch tabs, arrow keys or `j`/`k` move selection (`Accounts` reserves `k` for masked API-key entry, so use arrows or `j` there), `/` filters the current list (`Audit` filters only the loaded page text), `r` refreshes the visible resource, `?` opens help, `Enter` opens detail on medium-width terminals, and `Esc` returns from detail or closes. It uses a two-column list/detail layout at wide widths, a drill-in detail view at medium widths, and short tab labels with aggressive ANSI-aware truncation on narrow terminals. Remote labels are tab/newline-sanitized and all error/detail text is ANSI-wrapped.

- **Overview** shows the active connection, health (`Connected`, `Stale`, or `Error`), gateway version, server time, current principal, resource counts, and last refresh. Keys: `s` switches to another named connection after authenticated status succeeds; `r` refreshes status.
- **Users** manages managed users, tokens, guided ACL rules, ordered pool bindings, and usage. Keys: `c` opens a guided create-user form and one-time token modal; `e` edits description, owner, and role with prefilled values; `t` enables/disables the selected user; `d` deletes after typing the user name; `T` creates one token and opens the one-time token modal; `v` revokes a token with `token-id|confirmation`; `R` rotates all active tokens after typing `rotate <user-name>` and opens the one-time token modal; `U` loads usage with an optional `since` timestamp, blank for all time; `a` opens ACL effect/kind/catalog pickers with provider, model, route, Basic-routes, and custom provider/model suggestions; `x` opens an ACL rule picker and safe confirmation that keeps deletion progress and errors visible; `b` opens a pool picker to append a binding; `u` opens a current-binding picker and safe confirmation; `[` and `]` select the bound pool shown in detail; `+` and `-` submit an exact reordered pool-id permutation. Disabling/deleting the currently authenticated admin warns that the console will disconnect and requires the stronger `disconnect <user-name>` confirmation; revoking the current token warns the same way and requires the token public id. After any one-time token modal closes, the raw bearer is cleared and cannot be reopened.
- **Pools** manages provider-neutral pools and ordered account membership. Keys: `c` opens a guided create-pool form for name and strategy; `e` edits name and strategy with current values preselected; `d` deletes after typing the pool name; `a` opens a redacted live-account picker excluding existing members; `x` opens a member picker and safe confirmation, including unavailable stored member ids; `[` and `]` select the account member shown in the detail pane; `+` and `-` move the selected account by replacing the complete member order. List/show output displays strategy and account ids/counts, not provider/model ownership. The detail pane shows bound users.
- **Accounts** lists redacted provider accounts and never exposes provider secrets. Keys: `l` starts local provider OAuth/API-key login; `k` adds a masked direct API key for a typed provider id; `o` refreshes the selected OAuth credential only; `d` removes the selected account after typing its numeric id; `c` copies only non-secret identifiers. API-key rows say to remove and add a new key to rotate. Removing an account that is still in any pool returns `credential_in_use` with the pool names and leaves both the broker credential and pool state unchanged.
- **Audit** shows newest-first events and a detail inspector. Keys: `u` sets or clears the remote user-id filter; `/` applies a local text filter over the loaded page; `n` loads the next cursor page; `p` returns to the previous cursor page; `r` refreshes the current page. Audit has no delete or export action.

Local account login runs on the administrator client. The console invokes the registered provider flow locally, opens/copies the full auth URL from that machine, collects any manual code or masked API-key prompt locally, then immediately uploads the acquired credential to the gateway with `POST /v1/admin/credentials`. The gateway is the only broker client: it writes the credential to the broker through `RemoteAuthCredentialStore`, and management responses return only redacted summaries. The administrator profile, console state, errors, renders, and admin responses must not contain provider API keys, OAuth access tokens, OAuth refresh tokens, or the broker bearer.

Troubleshooting:

- `401 Unauthorized` means the selected profile's token is missing, malformed, expired, revoked, or was read from the wrong file/env/command source. Create or rotate a managed admin on the gateway host (`omp auth-gateway user create <name> --role=admin` or `omp auth-gateway user token <name> --regenerate`) and update the profile.
- `403 forbidden` means the token authenticated but is not a managed admin, or the gateway was started with `--no-auth` and management routes intentionally reject no-auth principals.
- TLS or certificate failures on remote hosts must be fixed in the OS/runtime trust store or reverse proxy. The console intentionally has no certificate bypass and refuses plaintext non-loopback `http://` before token resolution.
- A malformed profile JSON fails closed and is preserved byte-for-byte for repair. Fix duplicate names, dangling active connection names, unsupported document versions, invalid token-source fields, or invalid URLs in the active omp profile's `auth-gateways.json`.

## Usage cache: server-side 5-min jitter + client-side 15 s single-flight

Two layers cache the aggregate provider-usage report. Both are intentional and stacked.

### Server-side cache (broker `AuthStorage`)

`AuthStorage` caches each credential’s `UsageReport` in the broker’s SQLite store at a **5-minute per-credential TTL with ±25 % jitter**. Anthropic and OpenAI rate-limit `/usage` aggressively per source IP, and a synchronized 5-credential fan-out trips 429s every cycle; the jitter decorrelates refresh times within a few cycles. On fetch failure the store keeps the **last-good** report for up to 24 h with a short jittered re-poll window — so a transient upstream blip never blanks out the widget.

Constants: `USAGE_REPORT_TTL_MS = 5 * 60_000`, `USAGE_LAST_GOOD_RETENTION_MS = 24 * 60 * 60_000` (`packages/ai/src/auth-storage.ts`).

### Client-side single-flight (`RemoteAuthCredentialStore`)

When the gateway (or any other broker client) calls `fetchUsageReports()` / `getUsageReport(provider, credential)`, `RemoteAuthCredentialStore` coalesces concurrent calls into a single `GET /v1/usage` round-trip and caches the result for **15 s** in memory.

- `USAGE_CACHE_TTL_MS = 15_000` (`packages/ai/src/auth-broker/remote-store.ts`).
- A single `#usageInflight` promise is shared across all callers; a per-caller `AbortSignal` is **raced** against the shared promise, not threaded into it, so one caller’s abort never cascades into a peer’s in-flight request.
- On fetch failure the rejected promise is logged and the awaited value is `null` — callers (`AuthStorage.fetchUsageReports`, `#getUsageReport`) treat a `null` report as "no usage signal for this cycle" and proceed without it. **This is the 15 s TTL fallback**: the client absorbs transient broker outages by suppressing the error, returning `null` to ranking, and re-attempting after the 15 s window.

The 15 s client window deliberately sits below the broker’s 5 min server cache, so almost every client poll is served from the broker’s already-cached value; the client cache exists to absorb the parallel fan-out generated by `AuthStorage.#rankOAuthSelections` into a single broker round-trip.

## Client snapshot cache

`discoverAuthStorage()` persists the broker snapshot to `~/.omp/cache/auth-broker-snapshot.enc` after the initial `/v1/snapshot` fetch and after later broker-sourced full snapshots. The file is AES-256-GCM encrypted with `SHA-256(OMP_AUTH_BROKER_TOKEN)` and authenticated with the broker URL as additional data, so changing either the token or URL makes the cache unreadable. The file is written atomically with mode `0600`.

Freshness is anchored to the broker-stamped `snapshot.generatedAt`, not local write time. Default TTL is 1 h (`OMP_AUTH_BROKER_SNAPSHOT_TTL_MS`); `0` disables cache reads and writes. A fresh cache is revalidated against a reachable broker with a 500 ms startup budget, so an imported, revoked, or rotated credential is visible to one-shot commands immediately. If revalidation fails because the broker is unavailable or slow, `omp` starts from the cache and `RemoteAuthCredentialStore` continues normal SSE / long-poll synchronization in the background. Expired OAuth access tokens still refresh through `POST /v1/credential/:id/refresh`.

If the broker is down at boot and a fresh cache exists, startup succeeds from the cached snapshot. Authentication failures (401/403) are not masked by the cache; transient server errors fall back to it. If the cache is missing, expired, corrupt, written for a different URL, or encrypted with a different token, startup falls back to the live fetch and fails if the broker is unreachable.

## Client account pools (routing, not authorization)

Broker clients can restrict their visible OAuth accounts by setting `OMP_AUTH_BROKER_ACCOUNT_POOL_FILE` to a JSON file. The file maps provider IDs to exact `identityKey` values from the broker snapshot protocol:

```json
{
  "anthropic": ["email:alice@example.com|org:org-team"],
  "openai-codex": []
}
```

`identityKey` is the token-free identity field already carried by each authenticated `/v1/snapshot` credential entry. Operator tooling should project only `provider` and `identityKey`; it must not retain or print the accompanying credential payload. A dedicated account-listing CLI is intentionally outside this routing feature's scope.

SDK hosts can supply the same provider-to-identity mapping as `accountPool` in `discoverAuthStorage()` or `RemoteAuthCredentialStore`. An explicit programmatic pool takes precedence over the environment file.

- A missing provider is unrestricted.
- An empty array hides every OAuth credential for that provider.
- A non-empty array exposes only exact identity matches, including organization/workspace qualifiers.
- API-key credentials remain visible; the pool applies only to OAuth accounts.

The file is parsed once when broker-backed auth storage starts. An unreadable file, malformed JSON, or invalid provider entry aborts initialization rather than silently broadening the pool. Full snapshots, SSE updates, refresh responses, and aggregate usage are filtered consistently. For a provider named in the pool, aggregate reports are returned only when they can be attributed to a visible OAuth identity; reports attributable only to an API key or lacking matching identity metadata fail closed. The encrypted snapshot cache remains a raw broker snapshot so trusted processes sharing that cache can apply different pools.

This is a **trusted-client routing policy, not an authorization boundary**. The client still holds a broker bearer token, receives raw broker responses before applying its local view, and can call broker endpoints directly. Use server-side authorization—not account pools—when clients must be prevented from retrieving other credentials.

## Operator opt-in

The broker is **off** unless `OMP_AUTH_BROKER_URL` (or `auth.broker.url` in `config.yml`) is set. When set, `discoverAuthStorage` in `packages/coding-agent/src/sdk.ts` swaps the local SQLite credential store for `RemoteAuthCredentialStore` and every API call resolves credentials through the broker.

### Environment variables

| Variable                | Purpose                                                                                                                                            | Required when                                                                                                             |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `OMP_AUTH_BROKER_URL`   | Base URL of the remote auth-broker (e.g. `https://broker.tailnet:8765`). Selecting this puts the client in broker mode — local SQLite is bypassed. | Any time the omp client should resolve credentials through a broker (and required by `omp auth-gateway serve`).           |
| `OMP_AUTH_BROKER_TOKEN` | Bearer token used for every broker endpoint except `/v1/healthz`.                                                                                  | When `OMP_AUTH_BROKER_URL` is set and no token is available from `auth.broker.token` or `<config-dir>/auth-broker.token`. |
| `OMP_AUTH_BROKER_SNAPSHOT_TTL_MS` | Freshness window for the encrypted local snapshot cache. Default `3600000` (1 h); `0` disables cache reads and writes. | Optional in broker mode. |
| `OMP_AUTH_BROKER_SNAPSHOT_CACHE`  | Path override for the encrypted local snapshot cache. Default `~/.omp/cache/auth-broker-snapshot.enc` (or XDG cache equivalent). | Optional in broker mode. |
| `OMP_AUTH_BROKER_ACCOUNT_POOL_FILE` | JSON file mapping provider IDs to OAuth `identityKey` values visible to this trusted client. Parsed once; invalid files abort initialization. API keys are unaffected. | Optional in broker mode. |

Resolution order in `resolveAuthBrokerConfig()`:

1. `OMP_AUTH_BROKER_URL` env (else `auth.broker.url` from `config.yml`, resolved through `resolveConfigValue`);
2. `OMP_AUTH_BROKER_TOKEN` env (else `auth.broker.token` from `config.yml`, else `<config-dir>/auth-broker.token`);
3. URL set but no token resolvable → hard error pointing at the token file path.

The gateway has no dedicated env vars — it inherits `OMP_AUTH_BROKER_*` because it is itself a broker client.

### `config.yml` keys

| Key                 | Default | Purpose                                                                                                                                                                            |
| ------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auth.broker.url`   | unset   | Same as `OMP_AUTH_BROKER_URL`; env wins. Hidden from the settings UI. Values are resolved as a literal, an environment variable name, or `!<shell command>` to use trimmed stdout. |
| `auth.broker.token` | unset   | Same as `OMP_AUTH_BROKER_TOKEN`; env wins. Values are resolved the same way.                                                                                                       |

### Token files

| Path                              | Owner                                                | Mode                          |
| --------------------------------- | ---------------------------------------------------- | ----------------------------- |
| `<config-dir>/auth-broker.token`  | `omp auth-broker serve` (created at first start)     | `0600` in a `0700` parent dir |
| `<config-dir>/auth-gateway.token` | `omp auth-gateway serve` (skipped under `--no-auth`) | `0600` in a `0700` parent dir |

`<config-dir>` resolves to `~/.omp/` (respecting `PI_CONFIG_DIR`).

## Interaction with the local API-key resolution order

The broker only owns OAuth credentials and provider-API-key credentials that were uploaded to it. The standard credential ladder in `models.md` (`Auth and API key resolution order`) is preserved, with one addition committed alongside the gateway:

- `AuthStorage.setConfigApiKey / removeConfigApiKey / clearConfigApiKeys` let a `models.yml` `apiKey` beat a stored OAuth token **without** overriding an explicit `--api-key`. This is what allows a broker-resolved OAuth credential to be reliably shadowed by a per-environment `models.yml` config key when both are present.

## See also

- [`secrets.md`](./secrets.md) — secret obfuscation around tokens that _do_ leak through (e.g. `OMP_AUTH_BROKER_TOKEN` in shell output).
- [`models.md`](./models.md) — provider auth resolution order; the broker plugs in at layers 2–3 (stored credentials).
- [`environment-variables.md`](./environment-variables.md) — full env reference including `OMP_AUTH_BROKER_URL` / `OMP_AUTH_BROKER_TOKEN`.
