# Security policy

## Supported versions

Only the latest release is actively maintained. Security fixes are not backported to older releases.

## Reporting a vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

Report security issues privately via [GitHub Security Advisories](../../security/advisories/new) ("Report a vulnerability").

Include as much of the following as you can:

- Description of the vulnerability and potential impact.
- Steps to reproduce or proof-of-concept (if applicable).
- Affected versions.
- Any suggested mitigation.

You can expect an acknowledgement within 5 business days. We aim to triage and patch confirmed issues within 30 days.

---

## Security model

Lore is a **local-first tool**. Lore's own storage and network surface stay on your machine, and it does not send data to a Lore-operated remote service. Recalled context can still be included in the conversation sent by your host to its configured model, which may be cloud-hosted.

### What Lore stores

| File | Contents |
|---|---|
| `~/.config/lore/lore.db` | Session memories — code snippets, decisions, notes, file paths, and session summaries captured across your work history. |
| `~/.config/lore/lore.json` | Your preferences, rollout flags, and configuration. |

Treat `lore.db` the way you would any file that contains personal or work-related data. The same sensitivity applies to legacy files under `~/.copilot`, custom `LORE_HOME` or `XDG_CONFIG_HOME` locations, and migration backups.

**Optional hardening** — restrict read access to your user account:

```sh
chmod 600 ~/.config/lore/lore.db
chmod 600 ~/.config/lore/lore.json
```

### Browser dashboard

The browser UI is a **localhost-only, read-only HTTP server**. It has no authentication. When it is running, it displays the full contents of your memory store — code excerpts, session notes, file paths, and decisions from your work history.

Understand the surface before enabling it:

| Risk | Detail |
|---|---|
| No authentication | Any process on the same machine that can reach `localhost:PORT` can browse your full memory store. |
| Raw memory display | The UI renders exactly what Lore has stored, without redaction. |
| Browser extensions | Extensions with localhost access may be able to read the dashboard silently. |
| Proxy / forwarding misconfiguration | If a corporate proxy, reverse proxy, or developer tunnel inadvertently routes the port externally, your memory content is exposed. Verify your network setup before running the server. |

Mitigations Lore provides:

- The bind address is restricted to loopback hosts (`127.0.0.1`, `localhost`, or `::1`) — never `0.0.0.0` or any other network interface. The server cannot listen on a non-loopback interface by design.
- The server is **read-only**. There are no write endpoints.
- The server is **opt-in**. It only starts when you explicitly run `node scripts/run-browser.mjs`.

Your responsibilities:

- Do not proxy, tunnel, or forward the dashboard port outside localhost.
- Stop the server when you are not actively using it.
- Be aware of browser extensions with broad localhost permissions.

### Remote surface

There is no Lore-operated remote surface. Lore makes no non-loopback outbound network calls.

The optional `localInference` provider is default-off and accepts only `127.0.0.1`, `localhost`, or `::1`. When enabled, bounded session, retrieval, reflection, or capsule evidence is sent to that local model server. Deferred extraction, query expansion, context compression, and quality evaluation each require their own config opt-in. Reflection can use a persistent config opt-in, while an explicit per-call `useLocalInference` value overrides it. Consolidation, contradiction, supersession, and trend findings are advisory and cannot mutate trusted memory. When embeddings are enabled, Lore filters weak evidence and semantically validates generated claims before rendering; embedding vectors are cached in the local `memory_embedding` table. Lore rejects provider URLs containing credentials or non-loopback hosts.

### Portable export

The `memory_portable_bundle` tool (experimental) exports approved improvement artifacts, not a raw dump of the memory store. Review every JSON or OKF bundle before sharing; approved artifacts can still contain sensitive excerpts.

---

## Dependencies

Lore has **zero runtime dependencies** — it uses only Node built-ins. There is no `node_modules` tree to audit for supply-chain risk.
