# Workflow parity verification

OpenCode Visual adds original Claude-inspired workflows using OpenCode 1.19.0 contracts. This is not an exact clone or a claim that every Claude-only capability exists in OpenCode.

## Review boundaries

| Area | Commits | Evidence |
| --- | --- | --- |
| Session commands | `23fcdfc` | HTTP fixtures, native four-lens review acknowledged; independent runtime attempt timed out and was explicitly accepted as unavailable |
| MCP connection controls | `db56484` | Independent isolated 102 focused tests and typecheck; no live MCP or OAuth claim |
| Compact layout and transcript follow | `75277d0`, `a6b0832`, `c2cb710` | Independent corrected-candidate 57 focused tests, typecheck and observer-disposal probe; user visual acceptance |
| Session diff rendering | `4e0bd60` | 32 working-tree focused tests, typecheck, suite/build; complete controlled browser scenario at 360×740 |
| Searchable tools and skills | `b6a134c`, `e87e8fe`, `eacc1b3` | 44 working-tree / 43 clean-candidate focused tests, typecheck; complete controlled browser interactions |

The catalog work is split into formatter, standalone component and App integration commits. Review these units, not the accumulated feature branch. Eleven older working-tree changes remain outside the feature commits.

## Final candidate

- Code commit: `eacc1b37ecba55ca161487db5f5e9a6c93ed2601`.
- Clean source tree: `044295b62d635a513b450e1846d9ec53e3fb8923`.
- Final clean full-suite/build: `pnpm test && pnpm run build` exited 0 (background job 10, 12 seconds). This includes the webview and extension builds and typecheck.
- Current mixed working-tree full suite/build already exited 0; that is distinct from the clean-tree check.
- Native assessments of the isolated diff and catalog candidates returned medium risk, self-verification required, no independent verifier and `reviewDue: false` (`under_budget`). No new native review or consumed approval is claimed for these candidates.

## Browser evidence

Controlled scenarios use the actual React App with synthetic public data and mocked host callbacks, not a live OpenCode backend. Retained evidence is exported locally to ignored `.tools/ui-preview/parity-browser-evidence.json`.

- Diff: `ev_a7e21653432973a8c87de39c32e68ecfae3990dc26db97f50b7c983349ef2124`. Correct gutters, escaped text, raw/missing-patch fallbacks, local code overflow, no transcript overflow or unintended actions. Fixture controls successfully hidden.
- Catalog: `ev_296d41ae1f5db74d083e96df460db37d7864e4ed18d95e04ab0f97cd3c151a6b`. Search and Enter do not submit; skill selection preserves the draft, prepares a quoted reference and restores textarea focus/caret; Escape closes; no automatic discovery or execution; bounded narrow layout.
- Earlier fixture readiness/hide-control timeouts remain failures in the feature log. They were corrected and explicitly authorized for fresh verification, not relabeled as successful captures.

## Limits and warnings

- The historical same-ID streaming fixture reported a residual 9 px bottom gap. The user accepted the actual layout/follow behavior; this diagnostic was not made GREEN or re-investigated.
- No new live Extension Host, clipboard, MCP, command inference, provider-account, OAuth or complete IME proof is claimed. Gated live checks are not replaced by SSR or browser fixtures.
- Tools are metadata only. Skills prepare editable references; selecting one does not execute it. Actual use remains in OpenCode's agent/permission flow.
- The working build reports a webview chunk slightly above 500 kB and a Vitest/Vite configuration-loader compatibility warning. Neither was suppressed or treated as a build failure.
- A worker previously downloaded `tsx` into an external npm cache without authorization. The incident is recorded; project dependency files were unchanged and no external cleanup was attempted.
- No push, pull request, Marketplace publication or global model/provider change is authorized by these checks.

## Repeat offline checks

Use existing project dependencies: `pnpm test` and `pnpm run build` (includes typecheck). A clean checkout can verify the committed candidate separately from preserved older working-tree fixes. Live checks require their real environment and explicit operational scope; they must not silently invoke paid models or change account settings.
