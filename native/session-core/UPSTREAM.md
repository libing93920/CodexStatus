This crate extracts session management code from farion1231/cc-switch v4.0.21, fixed at commit c4db63c60d2a1ddcb4bd9f81152b9c6126413659.

The upstream project uses the MIT license; see LICENSE. Extracted provider, model, content, cache, Codex rollout, Kimi request-index, and Codex state-database sources are retained under src/upstream with upstream headers. Local changes are limited to provider-root routing, request-context configuration, link-safe traversal, and the public library boundary required by this application.

src/services.rs contains only the estimated_latency_ms helper required by the upstream Kimi request index. It mirrors the upstream duration validation without importing the application service graph.

Local binary policy modules add explicit SourceSpec routing, JSONL RPC, content revisions, Windows file leases, staged legacy copies, transactional OpenCode/Hermes deletion, Codex state/index synchronization, and explicit OpenCode database compaction. These are application safety and accounting changes, not an assertion that the vendored files are byte-for-byte upstream. Sources never use the application's account or proxy configuration.

The original in-module upstream Rust tests still reference fixtures and application test-support modules from the full cc-switch repository; they are not yet ported as a standalone Rust test suite. This extraction is currently verified through cargo build/check and the application-owned scripts/session-manager-core.test.mjs black-box suite against the compiled executable, plus Electron integration tests. Do not report cargo test --lib as passing.
