import { parseCliTranscript } from "../../lib/clients/cli-session-reader.mjs";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { readPiSessionFile } from "../../pi-session-reader.mjs";

const CLIENTS = Object.freeze(["copilot", "pi", "codex", "claude", "antigravity"]);
const CLIENT_CONTEXT = Object.freeze({
  copilot: "The extension checkpoint was reopened from its SQLite turn rows.",
  pi: "The archive replay came from Pi's append-only JSONL messages after compaction.",
  codex: "The evidence arrived as a Codex response item on the completed turn.",
  claude: "The active Claude parent branch carried this message after an abandoned branch.",
  antigravity: "The completed Antigravity planner step carried this evidence into the transcript.",
});

const CASES = Object.freeze([
  {
    id: "repo-preference",
    family: "preference",
    repository: "acme/checkout",
    user: "For this checkout repository, please prefer small pure functions over clever abstractions; it keeps review predictable.",
    assistant: "I will keep the implementation composed from small pure functions and explain any unavoidable state.",
    expected: [{ type: "user_preference", scope: "repo", anchors: ["prefer", "small", "pure", "functions", "checkout"] }],
    query: "How should helpers in checkout be structured?",
  },
  {
    id: "repo-rejection",
    family: "rejection",
    repository: "acme/payments",
    user: "Please avoid silently retrying payment mutations. A duplicate charge is worse than a visible failure, so retries need an idempotency key.",
    assistant: "The payment path will surface failures and only retry with an idempotency key.",
    expected: [{ type: "rejected_approach", scope: "repo", anchors: ["avoid", "silently", "retrying", "payment", "mutations"] }],
    query: "What retry rule did we settle on for payment mutations?",
  },
  {
    id: "global-style",
    family: "global",
    repository: "acme/editor",
    user: "Across all of my projects, I prefer examples that show the failure path before the happy path; this is a durable teaching preference.",
    assistant: "I will use failure-first examples when explaining work across repositories.",
    expected: [{ type: "user_preference", scope: "global", anchors: ["prefer", "examples", "failure", "path", "happy"] }],
    query: "What teaching style should I use in another project?",
  },
  {
    id: "decision-rationale",
    family: "decision",
    repository: "acme/ledger",
    user: "Which persistence layer should the ledger use under concurrent writers?",
    assistant: "We decided to use PostgreSQL because row-level locking and transactional constraints matter for concurrent ledger writers.",
    expected: [{ type: "decision", scope: "repo", anchors: ["decided", "PostgreSQL", "row-level", "locking", "concurrent"] }],
    query: "What persistence decision did we make for the ledger?",
  },
  {
    id: "question-only",
    family: "question",
    repository: "acme/search",
    user: "Would it make sense to always cache the search response, or should we measure the hit rate first? I am asking for options, not setting a rule.",
    assistant: "We should measure the hit rate before choosing a caching policy.",
    expected: [],
    forbidden: [{ anchors: ["always", "cache", "search", "response"] }],
    query: "Did we establish a cache rule for search?",
  },
  {
    id: "negated-directive",
    family: "negation",
    repository: "acme/importer",
    user: "The importer does not always need a background worker; for a one-shot repair, keeping it in the foreground is safer.",
    assistant: "That is a constraint for this repair, not a blanket preference about workers.",
    expected: [],
    forbidden: [{ anchors: ["always", "background", "worker"] }],
    query: "What did we decide about importer workers?",
  },
  {
    id: "quoted-rule",
    family: "quotation",
    repository: "acme/docs",
    user: "The old runbook says, \"Always publish from main.\" I am quoting it so we can replace that unsafe advice, not asking Lore to remember it.",
    assistant: "We should replace the runbook wording and require a reviewed release branch.",
    expected: [],
    forbidden: [{ anchors: ["always", "publish", "main"] }],
    query: "What publishing rule should the docs retain?",
  },
  {
    id: "hypothetical",
    family: "hypothetical",
    repository: "acme/alerts",
    user: "If we ever moved alert delivery to a queue, we might prefer batches of fifty, but that is only a scenario for discussion.",
    assistant: "The current alert delivery remains synchronous while we gather measurements.",
    expected: [],
    forbidden: [{ anchors: ["prefer", "batches", "fifty", "alert"] }],
    query: "What alert batch size is currently agreed?",
  },
  {
    id: "ordinary-bug-report",
    family: "bug-report",
    repository: "acme/api",
    user: "The API returned a 502 after the proxy upgrade. Please inspect the timeout and include the failing request in the bug report.",
    assistant: "I will inspect the proxy timeout and reproduce the failing request before proposing a change.",
    expected: [],
    forbidden: [{ anchors: ["prefer", "timeout", "proxy"] }],
    query: "Did we record an API timeout preference?",
  },
  {
    id: "correction",
    family: "correction",
    repository: "acme/worker",
    user: "Use a 30 second timeout for the worker.",
    assistant: "I will use a 30 second timeout.",
    correction: { user: "Actually, that is wrong: use a 45 second timeout because the upstream batch window is longer.", assistant: "Understood; the corrected worker timeout is 45 seconds for this repository." },
    expected: [{ type: "user_preference", scope: "repo", anchors: ["use", "45", "second", "timeout", "worker"] }],
    forbidden: [{ anchors: ["use", "30", "second", "timeout", "worker"] }],
    query: "Which worker timeout is the corrected one?",
  },
  {
    id: "changed-decision",
    family: "reversal",
    repository: "acme/catalog",
    user: "We initially chose Redis for catalog invalidation.",
    assistant: "The initial catalog decision was Redis.",
    correction: { user: "The decision changed after the durability review: use PostgreSQL notifications instead, because losing invalidations is unacceptable.", assistant: "The current decision is PostgreSQL notifications; Redis is historical context." },
    expected: [{ type: "decision", scope: "repo", anchors: ["decision", "PostgreSQL", "notifications", "durability", "invalidations"] }],
    forbidden: [{ anchors: ["initial", "Redis", "catalog", "invalidation"] }],
    query: "What is the current catalog invalidation decision?",
  },
  {
    id: "explicit-cross-project",
    family: "global",
    repository: "acme/cli",
    user: "Make this rule global across repositories: never put credentials in examples, including test fixtures, because readers copy them.",
    assistant: "I will treat credential-free examples as a cross-project rule and keep fixtures obviously synthetic.",
    expected: [{ type: "rejected_approach", scope: "global", anchors: ["never", "credentials", "examples", "test", "fixtures"] }],
    query: "What security rule applies to examples in a new repository?",
  },
  {
    id: "repo-default",
    family: "scope",
    repository: "acme/mobile",
    user: "For the mobile app only, prefer snapshot fixtures that include accessibility labels. This does not apply to my other repositories.",
    assistant: "I will keep that fixture preference scoped to the mobile app.",
    expected: [{ type: "user_preference", scope: "repo", anchors: ["prefer", "snapshot", "fixtures", "accessibility", "mobile"] }],
    query: "What fixture preference does the mobile app have?",
  },
  {
    id: "relevance-negative",
    family: "relevance",
    repository: "acme/infra",
    user: "The deployment question is still open; first compare the rollback runbooks and their recovery time objectives.",
    assistant: "I will compare the runbooks before recommending a deployment mechanism.",
    expected: [],
    forbidden: [{ anchors: ["prefer", "deployment", "mechanism"] }],
    query: "What is the capital of Finland?",
    negativeQuery: "How do penguins stay warm?",
  },
  {
    id: "long-window",
    family: "retention-window",
    repository: "acme/longrun",
    turnsBefore: 13,
    user: "Remember this repository decision: use append-only event records and derive projections asynchronously, because audit replay is required.",
    assistant: "I will preserve the append-only event decision and its audit replay rationale.",
    expected: [{ type: "user_preference", scope: "repo", anchors: ["append-only", "event", "records", "projections", "audit"] }],
    query: "What event storage decision protects audit replay?",
  },
  {
    id: "isolation-primary",
    family: "isolation",
    repository: "acme/alpha",
    user: "For alpha, prefer UTC timestamps in persisted records so ordering is stable across regions.",
    assistant: "Alpha will persist UTC timestamps for cross-region ordering.",
    expected: [{ type: "user_preference", scope: "repo", anchors: ["prefer", "UTC", "timestamps", "persisted", "alpha"] }],
    foreign: { repository: "acme/beta", user: "For beta, prefer local wall-clock timestamps in display reports.", assistant: "Beta display reports can use local wall-clock timestamps." },
    query: "What timestamp policy does alpha use?",
    forbidden: [{ anchors: ["local", "wall-clock", "timestamps", "beta"] }],
    critical: ["isolation"],
  },
  {
    id: "suppression",
    family: "suppression",
    repository: "acme/suppressed",
    user: "Prefer a compact release note with only user-visible changes; internal refactors belong in the engineering log.",
    assistant: "I will keep release notes focused on user-visible changes.",
    expected: [{ type: "user_preference", scope: "repo", anchors: ["prefer", "compact", "release", "note", "user-visible"] }],
    query: "How detailed should release notes be?",
    suppress: true,
    critical: ["suppression"],
  },
  {
    id: "multi-proposition",
    family: "multi-proposition",
    repository: "acme/edge",
    user: "For edge services, prefer bounded queues and never drop the request identifier from logs; both rules matter when diagnosing overload.",
    assistant: "I will retain both the bounded queue preference and the request identifier requirement.",
    expected: [
      { type: "user_preference", scope: "repo", anchors: ["prefer", "bounded", "queues", "edge"] },
      { type: "rejected_approach", scope: "repo", anchors: ["never", "drop", "request", "identifier", "logs"] },
    ],
    query: "What queue and logging rules apply to edge services?",
  },
  {
    id: "assistant-outcome",
    family: "decision",
    repository: "acme/stream",
    user: "We need to choose a serialization format for the stream boundary.",
    assistant: "After comparing compatibility and tooling, we chose Avro with a schema registry; the earlier JSON suggestion is not the final decision.",
    expected: [{ type: "decision", scope: "repo", anchors: ["chose", "Avro", "schema", "registry", "compatibility"] }],
    forbidden: [{ anchors: ["earlier", "JSON", "stream", "boundary"] }],
    query: "Which serialization format was chosen for the stream boundary?",
  },
  {
    id: "assistant-claim",
    family: "outcome-verification",
    repository: "acme/verify",
    user: "Can you investigate why the verification job is flaky?",
    assistant: "I think I fixed the verification job, but I have not run the complete suite yet.",
    expected: [],
    forbidden: [{ anchors: ["fixed", "verification", "job", "complete", "suite"] }],
    query: "What verified decision did we retain for the flaky job?",
  },
  {
    id: "soft-preference",
    family: "preference",
    repository: "acme/web",
    user: "It helps me when implementation notes lead with the user impact and then explain the code, so please use that order in this project.",
    assistant: "I will lead implementation notes with user impact and follow with the technical explanation.",
    expected: [{ type: "user_preference", scope: "repo", anchors: ["implementation", "notes", "user", "impact", "order"] }],
    query: "How should implementation notes be ordered here?",
  },
  {
    id: "explicit-forget",
    family: "suppression",
    repository: "acme/privacy",
    user: "Never retain personal customer names in debugging memories; use opaque account identifiers instead.",
    assistant: "I will use opaque identifiers and exclude personal names from retained debugging context.",
    expected: [{ type: "rejected_approach", scope: "repo", anchors: ["never", "retain", "personal", "customer", "names"] }],
    query: "What customer identifier rule applies to debugging memories?",
    suppress: true,
    critical: ["suppression"],
  },
  {
    id: "correction-implicit",
    family: "correction",
    repository: "acme/docs-site",
    user: "Please use the short link in the guide.",
    assistant: "I will use the short link.",
    correction: { user: "No, I meant the canonical full URL so copied guides remain self-contained.", assistant: "Understood; use the canonical full URL in the guide." },
    expected: [{ type: "user_preference", scope: "repo", anchors: ["canonical", "full", "URL", "copied", "guides"] }],
    forbidden: [{ anchors: ["short", "link", "guide"] }],
    query: "Which URL format is current for the guide?",
  },
  {
    id: "quoted-preference",
    family: "quotation",
    repository: "acme/review",
    user: "I disagree with the sentence \"Prefer one huge review commit.\" For this work, split changes by behavior so each commit can be reverted.",
    assistant: "I will split commits by behavior and keep each change independently revertible.",
    expected: [{ type: "user_preference", scope: "repo", anchors: ["split", "changes", "behavior", "commit", "reverted"] }],
    forbidden: [{ anchors: ["prefer", "one", "huge", "review", "commit"] }],
    query: "How should review commits be organized?",
  },
  {
    id: "global-identity",
    family: "global",
    repository: "acme/profile",
    user: "Across projects I work best with direct, concise status updates that name uncertainty instead of hiding it.",
    assistant: "I will keep status updates direct and call out uncertainty wherever we work.",
    expected: [{ type: "user_preference", scope: "global", anchors: ["status", "updates", "uncertainty", "direct", "concise"] }],
    query: "What status update style should carry into a different repository?",
  },
  {
    id: "negative-prefer-word",
    family: "bug-report",
    repository: "acme/runtime",
    user: "The word prefer appears in a compatibility warning from the runtime; this report describes observed behavior and does not set a preference.",
    assistant: "I will record the warning as diagnostic evidence and wait for a confirmed policy.",
    expected: [],
    forbidden: [{ anchors: ["prefer", "compatibility", "warning", "runtime"] }],
    query: "Did the runtime report create a preference?",
  },
  {
    id: "decision-tradeoff",
    family: "decision",
    repository: "acme/cache",
    user: "Should cache invalidation happen on a timer or from domain events?",
    assistant: "We chose domain events over a timer because an event gives us immediate invalidation without a polling race; document that tradeoff.",
    expected: [{ type: "decision", scope: "repo", anchors: ["chose", "domain", "events", "timer", "invalidation"] }],
    query: "Why did we choose domain events for cache invalidation?",
  },
  {
    id: "footer-link-do-not",
    family: "rejection",
    repository: "acme/site",
    user: "Do not remove the footer link from the documentation page. Keep the canonical support URL in the footer so readers can find maintenance guidance.",
    assistant: "I will preserve the canonical support URL in the documentation footer.",
    expected: [{ type: "rejected_approach", scope: "repo", anchors: ["do", "not", "remove", "footer", "link", "canonical"] }],
    query: "What footer link rule applies to the documentation page?",
  },
]);

// These conversations are intentionally independent of the adapter smoke
// cases above. Each row has its own proposition, repository, wording, and
// retrieval question; the five adapter envelopes are applied after this data
// is materialized.
const INDEPENDENT_SEEDS = Object.freeze([
  ["manifest-signing", "acme/artifacts", "Keep release manifests signed with the CI key so downstream mirrors can verify provenance.", "We will sign manifests in CI and publish the verification record.", "How are release manifests authenticated?", "user_preference", "repo", "release manifests signed CI provenance"],
  ["upload-checksum", "acme/uploads", "Require a SHA-256 checksum beside every uploaded archive; retries must not hide a changed payload.", "The upload record will include the checksum and reject mismatched retries.", "What integrity check protects uploaded archives?", "user_preference", "repo", "require SHA-256 checksum uploaded archive"],
  ["audit-retention", "acme/audit", "We decided to retain audit events for seven years because the regulator can request historical evidence.", "The seven-year audit retention decision is recorded with its regulatory rationale.", "How long are audit events retained and why?", "decision", "repo", "decided retain audit events seven years regulator"],
  ["batch-window", "acme/jobs", "Use a fifteen minute batch window for invoice jobs so late adjustments share one settlement run.", "Invoice jobs will use the fifteen minute settlement window.", "What batch window do invoice jobs use?", "user_preference", "repo", "use fifteen minute batch window invoice jobs"],
  ["no-inline-css", "acme/theme", "Do not put inline CSS in generated pages; the CSP policy depends on hashed stylesheet assets.", "Generated pages will reference hashed stylesheet assets instead of inline CSS.", "What styling approach is required by the page CSP?", "rejected_approach", "repo", "do not put inline CSS generated pages"],
  ["global-privacy", "acme/people", "Across my projects, never include real names in synthetic examples; privacy-safe placeholders are a global rule.", "I will use privacy-safe placeholders for examples in every repository.", "What example privacy rule applies everywhere?", "rejected_approach", "global", "never include real names synthetic examples"],
  ["cache-ttl", "acme/catalog", "The catalog cache should expire after twelve minutes because inventory freshness matters more than hit rate.", "Catalog entries will use a twelve-minute TTL and document the freshness tradeoff.", "What TTL did we choose for the catalog cache?", "user_preference", "repo", "catalog cache expire twelve minutes inventory freshness"],
  ["queue-order", "acme/events", "Preserve FIFO order for commands within one account; cross-account ordering is unnecessary.", "The event consumer will preserve per-account FIFO command order.", "What ordering guarantee applies to account commands?", "user_preference", "repo", "preserve FIFO order commands account"],
  ["token-redaction", "acme/gateway", "Redact bearer tokens before gateway requests enter debug logs, including failed requests.", "Gateway diagnostics will redact bearer tokens before logging success or failure.", "What must gateway debug logs redact?", "user_preference", "repo", "redact bearer tokens gateway debug logs"],
  ["sqlite-restore", "acme/restore", "We chose SQLite backups with an integrity check before replacement because restores run on a single host.", "SQLite backup restore with pre-replacement integrity validation is the selected approach.", "Which restore strategy did we select for the single-host service?", "decision", "repo", "chose SQLite backups integrity check replacement"],
  ["global-status", "acme/status", "For all work, tell me when evidence is uncertain instead of presenting an inference as a fact.", "I will label uncertainty whenever a conclusion is inferred rather than verified.", "How should uncertain status be communicated in other work?", "user_preference", "global", "all work tell uncertainty inference fact"],
  ["image-dimensions", "acme/media", "Validate image dimensions at the boundary so oversized uploads fail before thumbnail work begins.", "The media boundary will reject oversized dimensions before thumbnail processing.", "Where should image dimensions be validated?", "user_preference", "repo", "validate image dimensions boundary oversized uploads thumbnail"],
  ["webhook-signature", "acme/hooks", "Reject unsigned webhooks before parsing their JSON; parsing untrusted payloads first caused noisy failures.", "The hook endpoint will verify the signature before decoding the payload.", "What happens before webhook JSON is parsed?", "rejected_approach", "repo", "reject unsigned webhooks before parsing JSON"],
  ["postgres-lock", "acme/orders", "The order decision is PostgreSQL advisory locks because two workers must not claim the same order.", "PostgreSQL advisory locks are the recorded order-claim decision and rationale.", "Why did we choose advisory locks for orders?", "decision", "repo", "order decision PostgreSQL advisory locks workers claim"],
  ["search-fallback", "acme/search", "If the index is unavailable, return a clearly marked empty result rather than guessing from stale suggestions.", "Search will expose an empty fallback result and identify the index outage.", "What should search return during an index outage?", "user_preference", "repo", "index unavailable clearly marked empty result stale suggestions"],
  ["no-secret-fixtures", "acme/tests", "Never commit production secrets to fixtures; generated credentials must be visibly fake and scoped to the test.", "Fixtures will use visibly fake credentials with test-only scope.", "What credential rule applies to test fixtures?", "rejected_approach", "repo", "never commit production secrets fixtures"],
  ["migration-order", "acme/migrate", "Run schema validation before copying rows so a migration cannot create a partially understood database.", "The migration workflow will validate the schema before any row copy.", "What is the first safety step in the migration?", "user_preference", "repo", "run schema validation before copying rows migration"],
  ["feature-flag", "acme/flags", "We selected server-side feature flags over client guesses because rollback must take effect immediately.", "Server-side flags are the selected approach for immediate rollback control.", "Why are feature flags evaluated on the server?", "decision", "repo", "selected server-side feature flags client guesses rollback"],
  ["cron-timezone", "acme/schedules", "Schedule billing jobs in UTC; local daylight changes should never shift an invoice run.", "Billing schedules will use UTC to avoid daylight-driven shifts.", "Which timezone governs billing jobs?", "user_preference", "repo", "schedule billing jobs UTC"],
  ["markdown-links", "acme/guides", "Keep links as normal Markdown links so screen readers and copied documentation retain their targets.", "Guides will use normal Markdown links with durable targets.", "How should links be written in the guides?", "user_preference", "repo", "keep normal Markdown links screen readers copied documentation"],
  ["rate-limit-key", "acme/limits", "Key rate limits by account rather than IP because mobile clients can share an address.", "The limiter will use account identity as its key and retain the mobile-client rationale.", "What identifies a rate-limit bucket?", "user_preference", "repo", "rate limits account IP mobile clients"],
  ["global-commit", "acme/history", "Across repositories, make commits explain one behavior change so reviews and reverts stay legible.", "I will keep commits focused on one behavior change wherever we work.", "What commit structure should carry across repositories?", "user_preference", "global", "across repositories commits one behavior change reviews reverts"],
  ["csv-encoding", "acme/import", "Read incoming CSV as UTF-8 and reject invalid bytes with a line number for operators.", "The importer will validate UTF-8 and report the offending line.", "How does the CSV importer handle encoding errors?", "user_preference", "repo", "CSV UTF-8 reject invalid bytes line number"],
  ["job-idempotency", "acme/settlement", "Require an idempotency key on settlement commands; a client retry must not create a second payout.", "Settlement commands will reject missing keys and deduplicate retries.", "What prevents duplicate settlement payouts?", "user_preference", "repo", "require idempotency key settlement commands"],
  ["tracing-sampling", "acme/trace", "Sample successful requests at five percent but keep every failed trace so debugging retains the causal path.", "Tracing will use five percent success sampling and complete failure capture.", "What sampling policy did we set for request traces?", "user_preference", "repo", "sample successful requests five percent every failed trace"],
  ["api-version", "acme/public-api", "Expose the new report fields under API version v3; existing v2 clients must keep their response shape.", "The report fields will be added to v3 while v2 remains stable.", "Which API version receives the report fields?", "user_preference", "repo", "expose report fields API version v3"],
  ["no-background-delete", "acme/storage", "Do not delete objects in a background sweep until the retention ledger marks them eligible.", "Storage cleanup will consult the retention ledger before deleting an object.", "What guards object deletion?", "rejected_approach", "repo", "do not delete objects background sweep retention ledger eligible"],
  ["global-review", "acme/review", "I prefer review comments that name the requested behavior and a concrete reproduction, regardless of repository.", "Review comments will state behavior and reproduction details across projects.", "What makes a review comment useful everywhere?", "user_preference", "global", "prefer review comments behavior concrete reproduction"],
  ["decimal-money", "acme/money", "Represent money as integer minor units; binary floating point is not acceptable for totals.", "Money calculations will use integer minor units and avoid binary floating point.", "How should monetary totals be represented?", "user_preference", "repo", "represent money integer minor units"],
  ["tenant-header", "acme/tenants", "Validate the tenant header against the authenticated session before selecting a tenant database.", "Tenant selection will occur only after the header and session agree.", "When may the service select a tenant database?", "user_preference", "repo", "validate tenant header authenticated session database"],
  ["decision-graphql", "acme/graphql", "We decided to reject unknown GraphQL fields at validation time because permissive execution hides client drift.", "Unknown fields will fail validation and surface client drift early.", "Why does GraphQL reject unknown fields?", "decision", "repo", "decided reject unknown GraphQL fields validation client drift"],
  ["audit-hash-chain", "acme/ledger", "Chain audit records with the previous digest so tampering changes the verification result.", "Each audit record will carry the previous digest in the verification chain.", "How are ledger audit records chained?", "user_preference", "repo", "chain audit records previous digest tampering verification"],
  ["negative-cache-question", "acme/cache-question", "Should we cache the profile response, or first measure whether stale profiles are causing support tickets? This is an open question.", "We will measure stale-profile impact before setting a cache rule.", "Did we set a profile cache policy?", "", "repo", ""],
  ["negative-quoted-policy", "acme/policy", "The old note says \"Always bypass review for hotfixes\"; I am quoting it as an example of advice to remove.", "The replacement requires review evidence even for a hotfix.", "What hotfix review rule is current?", "", "repo", "always bypass review hotfixes"],
  ["negative-hypothesis", "acme/queue-question", "If we moved this queue to a broker, we could prefer a large batch, but no batch size has been chosen.", "The current queue remains unchanged while we compare broker costs.", "What queue batch size is agreed?", "", "repo", "prefer large batch queue broker"],
  ["negative-error", "acme/client-error", "The client timed out while waiting for the report endpoint; capture the request ID before investigating.", "I will trace the request ID and reproduce the timeout before selecting a policy.", "Did the timeout report establish a retry policy?", "", "repo", "retry policy timeout report"],
  ["negative-assistant-claim", "acme/check", "Can you inspect the flaky check?", "I believe the check is fixed, but the full suite has not run and this is not a verified decision.", "What verified policy did we retain for the check?", "", "repo", "fixed check verified policy"],
  ["retention-pointer", "acme/retention", "Store a pointer to the source object in the retention record, not a second plaintext copy.", "Retention records will point to source objects and avoid duplicate plaintext.", "What does a retention record store?", "user_preference", "repo", "store pointer source object retention record plaintext copy"],
  ["archive-format", "acme/archive", "Use zstd for cold archives because decompression speed matters during incident review.", "Cold archives will use zstd with incident review speed as the rationale.", "Which compression format is used for cold archives?", "user_preference", "repo", "use zstd cold archives decompression incident review"],
  ["locale-fallback", "acme/i18n", "Fall back to en-GB when a translation is missing so legal wording remains explicit.", "Missing translations will fall back to en-GB and emit a diagnostic.", "What locale is the translation fallback?", "user_preference", "repo", "fall back en-GB translation missing legal wording"],
  ["no-debug-pii", "acme/support", "Never log full support messages in debug mode; redact customer details before retaining diagnostic context.", "Support diagnostics will redact customer details before any debug retention.", "What must support debug logs exclude?", "rejected_approach", "repo", "never log full support messages debug mode"],
  ["websocket-heartbeat", "acme/realtime", "Send a heartbeat every twenty seconds so dead WebSocket peers are detected before work queues grow.", "The realtime server will send twenty-second heartbeats and close dead peers.", "How often does the WebSocket heartbeat run?", "user_preference", "repo", "heartbeat twenty seconds WebSocket dead peers"],
  ["global-tests", "acme/learning", "Across projects, write a regression test for every fixed bug so the explanation includes the original failure.", "I will pair each bug fix with a regression test and its original failure.", "What testing habit applies across projects?", "user_preference", "global", "regression test fixed bug original failure"],
  ["db-readonly", "acme/reporting", "Run reporting queries through a read-only database role; dashboards must not mutate operational data.", "Reporting will use a read-only role and reject mutation privileges.", "Which database role do dashboards use?", "user_preference", "repo", "run reporting queries read-only database role"],
  ["event-version", "acme/events-v2", "Version event payloads explicitly so consumers can reject an incompatible schema instead of guessing.", "Event consumers will inspect the explicit payload version before decoding.", "How are event payload versions handled?", "user_preference", "repo", "version event payloads explicit incompatible schema"],
  ["retry-backoff", "acme/network", "Use exponential backoff capped at two minutes for network retries so outages do not create a retry storm.", "Network retries will use exponential backoff with a two-minute cap.", "What backoff policy governs network retries?", "user_preference", "repo", "exponential backoff capped two minutes network retries"],
  ["negative-ordinary-note", "acme/notes", "The notes page lost its heading during the theme update; restore the heading before discussing navigation policy.", "I will restore the heading and inspect the theme diff first.", "Did the notes bug create a navigation preference?", "", "repo", "navigation preference theme update"],
  ["snapshot-naming", "acme/snapshots", "Name snapshots with the repository and UTC timestamp so operators can identify their source without opening them.", "Snapshots will use repository and UTC timestamp components in their names.", "How should snapshots be named?", "user_preference", "repo", "name snapshots repository UTC timestamp"],
  ["data-classification", "acme/data", "Classify imported records before indexing; restricted fields must never enter the general search index.", "The importer will classify records and route restricted fields away from general search.", "What happens before imported records are indexed?", "user_preference", "repo", "classify imported records before indexing"],
  ["global-tone", "acme/voice", "Use a calm, direct tone for difficult status updates in every repository; avoid theatrical certainty.", "I will keep difficult updates calm and direct while naming uncertainty.", "What tone should difficult status updates use?", "user_preference", "global", "use calm direct tone difficult status updates"],
  ["lock-timeout", "acme/locks", "Fail a lock acquisition after eight seconds and return a retryable error instead of waiting indefinitely.", "Lock acquisition will time out at eight seconds with a retryable error.", "What is the lock acquisition timeout?", "user_preference", "repo", "lock acquisition eight seconds retryable error"],
  ["no-implicit-cast", "acme/types", "Do not implicitly cast external numbers to booleans; validate the declared wire type at the boundary.", "The boundary validator will reject wire-type mismatches instead of casting them.", "What type safety rule applies to external numbers?", "rejected_approach", "repo", "do not implicitly cast external numbers booleans"],
  ["metrics-names", "acme/metrics", "Use stable metric names with a documented unit suffix so dashboards survive service renames.", "Metrics will use stable names and documented unit suffixes.", "How should service metrics be named?", "user_preference", "repo", "stable metric names documented unit suffix"],
  ["decision-s3", "acme/exports", "We chose object storage for exports because large files should not occupy the transactional database.", "Exports will use object storage while the database retains metadata and a pointer.", "Why did exports move to object storage?", "decision", "repo", "chose object storage exports large files transactional database"],
  ["negative-corrected-old", "acme/correct", "Use a ten second timeout for this endpoint.", "The endpoint will use ten seconds.", "What timeout applies after the upstream SLA correction?", "user_preference", "repo", "use twenty seconds timeout upstream SLA"],
  ["negative-hypothetical-cache", "acme/future", "If the service becomes multi-region, we might prefer active-active writes, but that is not a current decision.", "The service remains single-region while replication options are researched.", "What write topology is current?", "", "repo", "prefer active-active writes multi-region"],
  ["api-pagination", "acme/list", "Return an opaque cursor for pagination; clients should not infer ordering from numeric offsets.", "List responses will expose opaque cursors and a documented ordering field.", "How does the list API paginate?", "user_preference", "repo", "return opaque cursor pagination"],
  ["no-unbounded-input", "acme/parser", "Reject unbounded input fields before parsing so a malicious payload cannot consume memory.", "Parser limits will reject oversized fields before decoding the full payload.", "What protects the parser from oversized input?", "rejected_approach", "repo", "reject unbounded input fields before parsing memory"],
  ["global-uncertainty", "acme/decisions", "When a decision is tentative, label it tentative in every project until evidence closes the question.", "Tentative decisions will carry an explicit label until verified.", "How should tentative decisions be labeled?", "user_preference", "global", "tentative decision label every project evidence"],
  ["key-rotation", "acme/keys", "Rotate signing keys quarterly and retain the previous key long enough to verify in-flight tokens.", "Key rotation will happen quarterly with an overlap period for in-flight tokens.", "How often are signing keys rotated?", "user_preference", "repo", "rotate signing keys quarterly previous key in-flight tokens"],
  ["error-envelope", "acme/errors", "Return a stable error code and request ID in every API error envelope; prose alone is not automatable.", "API errors will include stable codes and request IDs alongside prose.", "What fields belong in an API error envelope?", "user_preference", "repo", "stable error code request ID API error envelope"],
  ["negative-quoted-retry", "acme/retry-note", "The incident says \"Always retry immediately\"; that quotation explains the outage and is not a retry instruction.", "The remediation adds capped backoff instead of immediate retries.", "What retry behavior is current after the incident?", "", "repo", "always retry immediately incident"],
  ["blob-encryption", "acme/blobs", "Encrypt stored blobs with the service key before replication; transport TLS alone is not storage protection.", "Blob encryption will occur before replication and use the service key.", "What protects replicated blobs at rest?", "user_preference", "repo", "encrypt stored blobs service key replication TLS"],
  ["release-channel", "acme/release", "Publish candidate builds to the beta channel for one day before promoting them to stable.", "Candidate builds will spend one day in beta before stable promotion.", "What release channel sequence did we choose?", "user_preference", "repo", "candidate builds beta channel one day stable"],
  ["global-copy", "acme/copy", "Prefer plain language in user-facing copy across projects; explain a technical term on first use.", "User-facing copy will use plain language and define technical terms once.", "What copy style should apply to user-facing text?", "user_preference", "global", "prefer plain language user-facing copy across projects"],
  ["lease-renewal", "acme/leases", "Renew a worker lease halfway through its duration and stop work if renewal fails.", "Workers will renew leases halfway through and halt safely on renewal failure.", "When should a worker renew its lease?", "user_preference", "repo", "renew worker lease halfway stop work renewal fails"],
  ["negative-bug-prefer", "acme/bug-text", "The crash report uses the word prefer in an example; it describes a parser bug and does not establish a preference.", "I will treat the report as evidence about the parser bug until a policy is chosen.", "Did the crash report establish a parser preference?", "", "repo", "prefer parser bug crash report"],
  ["schema-compat", "acme/schema", "Reject a schema migration that removes a required field until all readers have moved to the replacement.", "Schema review will block removal until reader migration is complete.", "When may a required schema field be removed?", "rejected_approach", "repo", "reject schema migration removes required field readers"],
  ["global-corrections", "acme/feedback", "When I correct an assumption, acknowledge the correction and use the new constraint in every project.", "I will acknowledge corrections and carry the corrected constraint forward.", "How should corrections be handled across projects?", "user_preference", "global", "correct assumption acknowledge correction new constraint"],
  ["worker-pool", "acme/pool", "Cap the image worker pool at twelve concurrent jobs so memory pressure stays predictable.", "The image worker pool will allow at most twelve concurrent jobs.", "What is the image worker concurrency limit?", "user_preference", "repo", "image worker pool twelve concurrent jobs memory"],
  ["no-raw-sql", "acme/query", "Do not concatenate user input into SQL; parameterized queries are mandatory at every repository boundary.", "Repository queries will use parameters and reject concatenated user input.", "What SQL construction rule is mandatory?", "rejected_approach", "repo", "do not concatenate user input SQL"],
  ["global-links", "acme/links", "Across repositories, preserve the destination of links when rewriting prose or formatting documentation.", "Documentation edits will keep link destinations unchanged unless explicitly requested.", "What should documentation rewrites preserve?", "user_preference", "global", "across repositories preserve destination links documentation"],
  ["decision-kafka", "acme/streaming", "We chose Kafka partitions keyed by customer because consumer ordering is needed within a customer.", "Kafka customer-keyed partitions are the recorded streaming decision.", "Why are streaming partitions keyed by customer?", "decision", "repo", "chose Kafka partitions customer consumer ordering"],
  ["clock-injection", "acme/time", "Inject the clock into expiry code so tests can cover a boundary without sleeping.", "Expiry code will receive an injected clock and deterministic boundary tests.", "How should expiry code obtain time?", "user_preference", "repo", "inject clock expiry code tests boundary sleeping"],
  ["negative-question-auth", "acme/auth-question", "Should we require passkeys for every account, or compare recovery support costs first? No policy is set.", "We will compare recovery costs before deciding the authentication policy.", "Did we decide on mandatory passkeys?", "", "repo", "require passkeys every account policy"],
  ["redaction-order", "acme/logging", "Redact sensitive headers before serializing the request for logs; redacting the final string leaves nested values exposed.", "Request logging will redact headers before serialization.", "When does request logging redact sensitive headers?", "user_preference", "repo", "redact sensitive headers before serializing request logs"],
  ["archive-index", "acme/history-index", "Index archive metadata separately from message bodies so a retention purge can remove derived text safely.", "Archive metadata and message bodies will have separate indexes for controlled purge.", "How are archive metadata and message bodies indexed?", "user_preference", "repo", "index archive metadata separately message bodies retention purge"],
  ["global-commit-message", "acme/commits", "Use imperative commit subjects in all repositories so release notes can derive clear actions.", "Commit subjects will use imperative wording across repositories.", "What commit subject style should releases expect?", "user_preference", "global", "imperative commit subjects all repositories release notes"],
  ["dead-letter", "acme/dlq", "Move messages to a dead-letter queue after three processing failures and preserve the original error.", "The consumer will dead-letter after three failures with the original error attached.", "When does a message enter the dead-letter queue?", "user_preference", "repo", "dead-letter queue three processing failures original error"],
  ["no-silent-truncate", "acme/text", "Do not silently truncate user text; return a visible limit error and record the accepted maximum.", "Text input will return a visible limit error instead of silently truncating.", "What happens when user text exceeds the limit?", "rejected_approach", "repo", "do not silently truncate user text"],
  ["global-rollback", "acme/ops", "Across projects, keep rollback instructions beside deployment steps so an operator can recover under pressure.", "I will place rollback instructions next to deployment steps wherever we work.", "Where should rollback instructions live?", "user_preference", "global", "across projects rollback instructions beside deployment steps"],
  ["decision-tls", "acme/tls", "Use TLS 1.3 for internal service calls because the platform supports it and handshake latency is acceptable.", "Internal calls will use TLS 1.3 with the measured latency tradeoff.", "Which TLS version did we choose internally?", "user_preference", "repo", "use TLS 1.3 internal service calls handshake latency"],
  ["queue-depth", "acme/backpressure", "Pause intake when the queue reaches eight thousand messages and resume below six thousand.", "Backpressure will pause at eight thousand and resume below six thousand.", "What queue depth triggers backpressure?", "user_preference", "repo", "pause intake queue eight thousand resume six thousand"],
  ["negative-hypothetical-db", "acme/db-future", "If we outgrow one writer, we might prefer a distributed database, but the current service still uses one writer.", "We will measure writer contention before considering a distributed database.", "What database topology is current?", "", "repo", "prefer distributed database outgrow writer"],
  ["boundary-json", "acme/json", "Reject duplicate JSON keys at the ingestion boundary because different parsers choose different values.", "Ingestion will reject duplicate keys and report the field name.", "Why are duplicate JSON keys rejected?", "rejected_approach", "repo", "reject duplicate JSON keys ingestion boundary parsers"],
  ["global-evidence", "acme/evidence", "For any project, distinguish observed evidence from an assumption in notes and reviews.", "Notes and reviews will label observations separately from assumptions.", "How should notes distinguish evidence and assumptions?", "user_preference", "global", "any project distinguish observed evidence assumption notes reviews"],
  ["session-cookie", "acme/session", "Set session cookies with Secure, HttpOnly, and SameSite=Lax attributes before enabling the login flow.", "The login flow will set all three session-cookie attributes.", "Which attributes must session cookies set?", "user_preference", "repo", "session cookies Secure HttpOnly SameSite Lax"],
  ["decision-queue-db", "acme/work", "We decided to persist the work queue in PostgreSQL rather than process memory so restarts do not lose jobs.", "PostgreSQL persistence is the work-queue decision for restart durability.", "Why is the work queue persisted in PostgreSQL?", "decision", "repo", "decided work queue PostgreSQL process memory restarts jobs"],
  ["negative-quoted-always", "acme/quote", "A copied comment says \"Always use the fast path\"; the comment is being audited, not retained as a directive.", "The audit will compare the fast path with the guarded path before deciding.", "Did the copied comment create a fast-path rule?", "", "repo", "always use fast path copied comment"],
  ["trace-correlation", "acme/trace-id", "Propagate one correlation ID through HTTP, queue, and database logs so an incident can be followed end to end.", "The correlation ID will be propagated through each boundary.", "What identifier links logs across service boundaries?", "user_preference", "repo", "correlation ID HTTP queue database logs"],
  ["global-small-diffs", "acme/diffs", "Prefer small, reviewable diffs across all repositories so each change has a clear rollback point.", "I will keep diffs small and reviewable across projects.", "What change size preference carries across repositories?", "user_preference", "global", "prefer small reviewable diffs rollback point"],
  ["redelivery-count", "acme/delivery", "Stop redelivering a message after five attempts and retain the delivery history for operators.", "Delivery will stop after five attempts with history retained.", "After how many attempts does delivery stop?", "rejected_approach", "repo", "stop redelivering message five attempts delivery history"],
  ["no-unsafe-default", "acme/defaults", "Do not choose an unsafe default when configuration is missing; fail closed and explain the missing setting.", "Missing configuration will produce a clear fail-closed error.", "What happens when a safety setting is missing?", "rejected_approach", "repo", "do not unsafe default configuration missing fail closed"],
  ["global-summaries", "acme/summaries", "Across projects, put the decision and its reason before implementation detail in session summaries.", "Session summaries will lead with decisions and reasons.", "How should session summaries be structured?", "user_preference", "global", "across projects decision reason before implementation detail"],
  ["decision-protobuf", "acme/proto", "Use Protobuf for the internal command stream because generated schemas make compatibility checks explicit.", "Internal commands will use Protobuf with generated compatibility checks.", "Which format did we choose for internal commands?", "user_preference", "repo", "use Protobuf internal command stream generated schemas compatibility"],
  ["cache-invalidation", "acme/invalidate", "Invalidate account summaries from the account-updated event rather than polling every minute.", "Account updates will emit invalidation events and avoid a polling loop.", "How are account summaries invalidated?", "user_preference", "repo", "invalidate account summaries account-updated event polling"],
  ["negative-bug-never", "acme/bug-never", "The bug report says the worker never acknowledged a packet; that is an observation, not a permanent prohibition.", "I will inspect the acknowledgement path before changing worker policy.", "Did the bug report create a worker prohibition?", "", "repo", "never acknowledged packet worker prohibition"],
  ["payload-limit", "acme/payload", "Limit webhook payloads to two megabytes and return a typed error when the limit is exceeded.", "Webhook intake will enforce a two-megabyte payload limit.", "What is the webhook payload limit?", "user_preference", "repo", "webhook payloads two megabytes typed error"],
  ["global-plain-errors", "acme/errors-copy", "Use actionable error messages in every project: name the failed operation and the next safe step.", "Errors will name the failed operation and offer a safe next step.", "What should an actionable error message contain?", "user_preference", "global", "actionable error messages failed operation safe step"],
  ["worker-shutdown", "acme/shutdown", "Stop accepting new work before closing database connections so in-flight jobs can finish cleanly.", "Shutdown will drain intake before closing the database.", "What order should worker shutdown follow?", "rejected_approach", "repo", "stop accepting work before closing database connections"],
  ["decision-oidc", "acme/identity", "Use OIDC for service identity because short-lived tokens reduce credential rotation burden.", "Service identity will use OIDC and short-lived tokens.", "Why did we choose OIDC for service identity?", "user_preference", "repo", "use OIDC service identity short-lived tokens rotation"],
  ["negative-question-retain", "acme/retain-question", "Should retained notes include every tool output, or only evidence that changes a future decision? I am asking for guidance.", "We will compare retrieval noise before choosing a retention rule.", "Did we choose which tool output to retain?", "", "repo", "retained notes every tool output evidence future decision"],
  ["no-public-stack", "acme/security", "Do not expose stack traces in public errors; keep diagnostic details in protected logs with a request ID.", "Public errors will contain a request ID while protected logs retain diagnostics.", "Where should stack traces appear?", "rejected_approach", "repo", "do not expose stack traces public errors"],
  ["global-open-items", "acme/planning", "Across repositories, keep unresolved risks as explicit open items instead of silently dropping them from summaries.", "Unresolved risks will remain visible as open items in summaries.", "How should unresolved risks appear in summaries?", "user_preference", "global", "across repositories unresolved risks explicit open items summaries"],
  ["decision-index", "acme/index", "Use an inverted index for exact identifiers and semantic search only as a supplemental ranking signal.", "Exact identifiers will use the inverted index, with semantic ranking supplemental.", "Which search path handles exact identifiers?", "user_preference", "repo", "inverted index exact identifiers semantic supplemental"],
  ["clock-source", "acme/clock", "Read monotonic time for elapsed durations and wall time only for displayed timestamps.", "Duration calculations will use monotonic time while displays use wall time.", "Which clock source is used for elapsed durations?", "user_preference", "repo", "monotonic time elapsed durations wall time timestamps"],
  ["negative-quote-never", "acme/quote-never", "The proposal quotes \"Never page after midnight\" as a rule to challenge; it is not an adopted on-call policy.", "We will review actual overnight incidents before setting paging hours.", "What paging-hours policy was adopted?", "", "repo", "never page after midnight on-call policy"],
  ["request-budget", "acme/budget", "Cap each request's downstream fan-out at four services so latency remains explainable.", "Requests will allow at most four downstream calls and record the cap.", "What limits downstream request fan-out?", "user_preference", "repo", "request downstream fan-out four services latency"],
  ["global-review-links", "acme/review-links", "When reviewing any repository, link a claim to the file or test that supports it.", "Reviews will connect claims to supporting files or tests.", "What evidence should review claims include?", "user_preference", "global", "review any repository claim file test supports"],
  ["idempotent-migration", "acme/migration-id", "Make migration steps idempotent so a crash after a committed step can resume safely.", "Migration steps will be rerunnable after a crash without duplicating changes.", "What restart property should migrations have?", "user_preference", "repo", "migration steps idempotent crash resume safely"],
  ["negative-error-prefer", "acme/error-prefer", "A support ticket says users prefer faster exports; it reports sentiment and is not a durable performance target.", "I will measure export latency and support volume before selecting a target.", "Did the support ticket set an export target?", "", "repo", "prefer faster exports support ticket performance target"],
  ["no-implicit-global", "acme/scope", "Infer repository scope from the active workspace unless I explicitly declare a rule cross-project.", "The scope resolver will keep workspace guidance local by default.", "What is the default scope for workspace guidance?", "user_preference", "repo", "infer repository scope active workspace cross-project"],
  ["decision-retention-window", "acme/window", "Retain the last thirty days of operational events online and archive older events for audit retrieval.", "Operational storage will keep thirty days online and archive older events.", "What is the operational event retention split?", "user_preference", "repo", "retain thirty days operational events archive older audit"],
  ["global-naming", "acme/naming", "Use descriptive names instead of unexplained abbreviations in code across all repositories.", "I will use descriptive names and explain necessary abbreviations.", "What naming style carries across repositories?", "user_preference", "global", "descriptive names unexplained abbreviations code"],
  ["header-size", "acme/http", "Reject HTTP headers larger than sixteen kilobytes before routing the request.", "The edge will reject headers over sixteen kilobytes before routing.", "What header-size limit applies before routing?", "rejected_approach", "repo", "reject HTTP headers sixteen kilobytes routing"],
  ["negative-hypothetical-global", "acme/global-future", "If we ever publish a public SDK, we might prefer generated clients, but that possibility is not current guidance.", "The SDK direction remains open until the API stability review.", "What SDK generation policy is current?", "", "global", "prefer generated clients public SDK"],
  ["audit-actor", "acme/audit-actor", "Record the authenticated actor and request ID on every administrative change.", "Administrative audit entries will include actor and request ID fields.", "Which fields identify an administrative change?", "user_preference", "repo", "authenticated actor request ID administrative change"],
  ["decision-queue-priority", "acme/priority", "Process account deletion before analytics work because privacy erasure has the higher priority.", "The queue will prioritize account deletion over analytics jobs.", "Which queue work has priority over analytics?", "user_preference", "repo", "process account deletion before analytics privacy priority"],
  ["no-duplicate-events", "acme/events-id", "Do not emit the same domain event twice for one committed transition; consumers rely on event identity.", "Event identity will prevent duplicate emission for a committed transition.", "What prevents duplicate domain events?", "rejected_approach", "repo", "do not emit same domain event twice committed transition"],
  ["global-outcome", "acme/outcomes", "Across projects, record the final outcome and its evidence, not only the initial question.", "Summaries will prefer evidenced outcomes over unanswered initial questions.", "What should a cross-project summary emphasize?", "user_preference", "global", "across projects final outcome evidence initial question"],
  ["rollback-marker", "acme/deploy-marker", "Write a rollback marker before changing production traffic so the previous version is unambiguous.", "Deployment will write the rollback marker before shifting traffic.", "When is the rollback marker written?", "user_preference", "repo", "rollback marker before changing production traffic previous version"],
  ["negative-ordinary-prefer", "acme/ordinary-prefer", "The incident timeline notes that operators prefer the old dashboard; this is context for a redesign discussion, not a directive.", "We will collect dashboard tasks before deciding which view to keep.", "Did the incident timeline create a dashboard preference?", "", "repo", "prefer old dashboard incident timeline directive"],
  ["safe-parser", "acme/safe-parser", "Parse untrusted YAML with aliases disabled because recursive aliases can exhaust memory.", "The YAML parser will disable aliases before reading untrusted input.", "Which YAML parser safety option is required?", "user_preference", "repo", "YAML aliases disabled recursive aliases memory"],
  ["global-questions", "acme/questions", "When a prompt is only a question, do not store it as a preference until a decision is explicitly made.", "Questions will remain exploratory until an explicit decision appears.", "How should question-only prompts be treated?", "rejected_approach", "repo", "question only do not store preference explicit decision"],
  ["decision-restore", "acme/restore-v2", "Restore snapshots into a staging file and validate them before replacing the active database.", "Snapshot restore will stage and validate before active replacement.", "How should database snapshots be restored?", "user_preference", "repo", "restore snapshots staging file validate replacing active database"],
  ["no-credential-output", "acme/output", "Never print access tokens in command output, even when a diagnostic command fails.", "Diagnostic commands will redact access tokens on success and failure.", "What must diagnostic command output exclude?", "rejected_approach", "repo", "never print access tokens command output diagnostic fails"],
  ["global-reversals", "acme/reversals", "When a choice changes, preserve the current choice and label the old one as historical in every project.", "Changed decisions will keep the current choice clear and mark prior choices historical.", "How should changed decisions be represented?", "user_preference", "global", "choice changes current historical every project"],
  ["concurrency-limit", "acme/concurrency", "Limit concurrent report generation to three jobs because each job holds a large working set.", "Report generation will run at most three jobs concurrently.", "What limits concurrent report generation?", "user_preference", "repo", "limit concurrent report generation three jobs working set"],
]);

// Independently annotated additional directives within the same conversation.
const ADDITIONAL_PROPOSITIONS = Object.freeze({
  "upload-checksum": [
    [
      "rejected_approach",
      "retries must not hide changed payload"
    ]
  ],
  "no-secret-fixtures": [
    [
      "user_preference",
      "generated credentials visibly fake scoped test"
    ]
  ],
  "cron-timezone": [
    [
      "rejected_approach",
      "daylight changes never shift invoice run"
    ]
  ],
  "job-idempotency": [
    [
      "rejected_approach",
      "client retry must not create second payout"
    ]
  ],
  "api-version": [
    [
      "user_preference",
      "existing v2 clients keep response shape"
    ]
  ],
  "decimal-money": [
    [
      "rejected_approach",
      "binary floating point not acceptable totals"
    ]
  ],
  "no-debug-pii": [
    [
      "user_preference",
      "redact customer details before retaining diagnostic context"
    ]
  ],
  "db-readonly": [
    [
      "rejected_approach",
      "dashboards must not mutate operational data"
    ]
  ],
  "data-classification": [
    [
      "rejected_approach",
      "restricted fields never enter general search index"
    ]
  ],
  "global-tone": [
    [
      "rejected_approach",
      "avoid theatrical certainty"
    ]
  ],
  "no-implicit-cast": [
    [
      "user_preference",
      "validate declared wire type boundary"
    ]
  ],
  "api-pagination": [
    [
      "rejected_approach",
      "clients should not infer ordering numeric offsets"
    ]
  ],
  "global-copy": [
    [
      "user_preference",
      "explain technical term first use"
    ]
  ],
  "no-raw-sql": [
    [
      "user_preference",
      "parameterized queries mandatory every repository boundary"
    ]
  ],
  "no-silent-truncate": [
    [
      "user_preference",
      "return visible limit error record accepted maximum"
    ]
  ],
  "no-public-stack": [
    [
      "user_preference",
      "keep diagnostic details protected logs request ID"
    ]
  ]
});

function buildIndependentBlueprints() {
  return INDEPENDENT_SEEDS.map(([id, repository, user, assistant, query, type, scope, anchorText]) => ({
    id: `independent-${id}`,
    family: type || "negative",
    repository,
    user,
    assistant,
    type,
    ...(id === "negative-corrected-old" ? {
      correction: {
        user: "Actually, that is wrong: use twenty seconds for the endpoint timeout because the upstream SLA changed.",
        assistant: "The corrected endpoint timeout is twenty seconds.",
      },
    } : {}),
    expected: type ? [
      { type, scope, anchors: anchorText.split(" ") },
      ...(ADDITIONAL_PROPOSITIONS[id] ?? []).map(([extraType, text]) => ({ type: extraType, scope, anchors: text.split(" ") })),
    ] : [],
    forbidden: id === "negative-corrected-old"
      ? [{ anchors: ["ten", "seconds", "timeout", "endpoint"] }]
      : type ? [] : [{ anchors: anchorText.split(" ") }],
    query,
  }));
}

const INDEPENDENT_BLUEPRINTS = Object.freeze(buildIndependentBlueprints());

// Bare imperative task language is intentionally excluded from durable
// extraction. Independent positive cases therefore state their durability
// explicitly so this corpus tests retention, scope, and replay across clients
// without weakening that safety boundary.
function materializeIndependentPolicyMessage(blueprint) {
  const clauses = blueprint.user.split(/;\s*/u);
  const sourceId = blueprint.id.replace(/^independent-/u, "");
  const additional = ADDITIONAL_PROPOSITIONS[sourceId] ?? [];
  return clauses.map((clause, index) => {
    if (index === 0 && blueprint.type === "user_preference") {
      return `As a policy, I prefer this: ${clause}`;
    }
    if (index > 0 && additional[index - 1]?.[0] === "user_preference") {
      return `I prefer this: ${clause}`;
    }
    return clause;
  }).join("; ");
}

function clientLabel(client) {
  return client[0].toUpperCase() + client.slice(1);
}

function materializeTurns(blueprint, client) {
  const tail = blueprint.turnsBefore
    ? Array.from({ length: blueprint.turnsBefore }, (_, index) => ({
      user_message: `Progress note ${index + 1}: inspect the ${clientLabel(client)} fixture without making a durable policy decision.`,
      assistant_response: "No durable preference was established in this progress note.",
    }))
    : [];
  const turns = [
    { user_message: `${materializeIndependentPolicyMessage(blueprint)} ${CLIENT_CONTEXT[client]}`, assistant_response: `${blueprint.assistant} ${CLIENT_CONTEXT[client]}` },
    ...tail,
  ];
  if (blueprint.correction) turns.splice(1, 0, { user_message: blueprint.correction.user, assistant_response: blueprint.correction.assistant });
  return turns.map((turn, index) => ({ ...turn, turn_index: index + 1 }));
}

function canonicalArtifacts(blueprint, client, repository = blueprint.repository) {
  const turns = materializeTurns(blueprint, client).map((turn) => ({ ...turn, source_record_id: `${client}-${blueprint.id}-${turn.turn_index}` }));
  return {
    session: { id: `${client}:${blueprint.id}`, cwd: `/tmp/lore-quality/${client}`, repository, branch: "quality", summary: `Synthetic ${client} quality scenario ${blueprint.id}`, updated_at: "2026-09-07T12:00:00.000Z" },
    checkpoints: [], files: [], refs: [], turns,
  };
}

function encodeRawEntries(blueprint, client) {
  const turns = materializeTurns(blueprint, client);
  if (client === "codex") {
    return turns.flatMap((turn) => [
      { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: turn.user_message }] } },
      { type: "response_item", payload: { type: "reasoning", summary: "private reasoning omitted" } },
      { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: turn.assistant_response }] } },
    ]);
  }
  if (client === "claude") {
    let parentUuid = null;
    return turns.flatMap((turn, index) => {
      const userUuid = `${blueprint.id}-u-${index}`;
      const assistantUuid = `${blueprint.id}-a-${index}`;
      const entries = [
        { uuid: userUuid, parentUuid, type: "user", message: { role: "user", content: turn.user_message } },
        { uuid: assistantUuid, parentUuid: userUuid, type: "assistant", message: { role: "assistant", content: [{ type: "thinking", thinking: "private reasoning omitted" }, { type: "text", text: turn.assistant_response }] } },
      ];
      parentUuid = assistantUuid;
      return entries;
    });
  }
  if (client === "antigravity") {
    return turns.flatMap((turn, index) => [
      { step_index: index * 2, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", content: `<USER_REQUEST>${turn.user_message}</USER_REQUEST><ADDITIONAL_METADATA>fixture metadata</ADDITIONAL_METADATA>` },
      { step_index: index * 2 + 1, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", content: turn.assistant_response },
    ]);
  }
  return null;
}

export function parseScenarioTranscript(blueprint, client) {
  if (client === "copilot") return canonicalArtifacts(blueprint, client);
  if (client === "pi") {
    const home = mkdtempSync(path.join(os.tmpdir(), "lore-quality-pi-"));
    const filePath = path.join(home, "session.jsonl");
    const turns = materializeTurns(blueprint, client);
    const entries = [
      { type: "session", id: `pi:${blueprint.id}`, cwd: `/tmp/lore-quality/pi`, timestamp: "2026-09-07T12:00:00.000Z" },
      ...turns.flatMap((turn) => [
        { type: "message", timestamp: "2026-09-07T12:00:01.000Z", message: { role: "user", content: [{ type: "text", text: turn.user_message }] } },
        { type: "message", timestamp: "2026-09-07T12:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: turn.assistant_response }, { type: "toolCall", name: "read", arguments: { path: "README.md" } }] } },
        { type: "message", timestamp: "2026-09-07T12:00:03.000Z", message: { role: "toolResult", content: "ignored tool output" } },
      ]),
    ];
    try {
      writeFileSync(filePath, `${entries.map(JSON.stringify).join("\n")}\n`, "utf8");
      return readPiSessionFile(filePath, { repository: blueprint.repository }).sessionArtifacts;
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }
  const raw = encodeRawEntries(blueprint, client);
  return parseCliTranscript(raw.map(JSON.stringify).join("\n"), {
    client,
    sessionId: `${client}:${blueprint.id}`,
    cwd: `/tmp/lore-quality/${client}`,
    repository: blueprint.repository,
    timestamp: "2026-09-07T12:00:00.000Z",
  });
}

export function buildScenario(blueprint, client) {
  return Object.freeze({
    ...blueprint,
    client,
    scenarioId: `${client}:${blueprint.id}`,
    sessionId: `${client}:${blueprint.id}`,
    transcript: parseScenarioTranscript(blueprint, client),
  });
}

export const RELIABILITY_BLUEPRINTS = Object.freeze([...CASES, ...INDEPENDENT_BLUEPRINTS]);
export const RELIABILITY_CLIENTS = CLIENTS;
export const RELIABILITY_CORPUS = Object.freeze(CLIENTS.flatMap((client) => RELIABILITY_BLUEPRINTS.map((blueprint) => buildScenario(blueprint, client))));
