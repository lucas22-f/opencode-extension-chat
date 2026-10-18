# Claude-inspired chat — ODD feature
Objective: research the official VS Code experience and deliver a bounded visual refresh without changing OpenCode contracts.
Branch: `feat/claude-inspired-chat`; delivery: ask-on-risk, forecast ~380 authored lines; runner: `pnpm exec vitest run --config vitest.config.ts`.

## Specs

- S1: "https://code.claude.com/docs/en/vs-code" / "investiga la doc para saber mas de como armar la extension nuestra.." — compare the official reference against existing pinned OpenCode capabilities and record sources and limitations.
- S2: "ademas de tener una ui muy similar pero otro color" — use the supplied screenshots as visual references for compact navigation, quiet conversation canvas, bottom composer and inline tool activity; retain independent branding. Implementation assumption: teal accent with theme-aware surfaces.
- S3: "C:\Users\lucas\AppData\Local\Temp\gpu8pLfE\pi-clipboard-8f357032-b5fa-4e44-9a61-114d7d5868b3.png" / "C:\Users\lucas\AppData\Local\Temp\gpu8pLfE\pi-clipboard-e81dfd83-d74c-4226-8362-0b6d89941132.png" — first screenshot shows empty chat and bordered composer; second shows conversation/tool timeline. Check structural rendering for both states; do not claim screenshot equivalence without a browser/Extension Host check.
- S4: "se entiende ? trabaja en eso" — implement the scoped presentation improvement, not just a proposal. Existing safety, prompt, session, choice and permission behavior stays unchanged.

## Tasks

- T1 | S1 | route: delegated explore (documentation mapping exceeded one bounded read batch) | done: official guide and repository capability comparison returned | commit: `fd73503`.
- T2 | S2-S4 | route: inline (one dependent visual behavior; no writer trigger) | done: compact native disclosures, header New, branded empty canvas, teal theme-aware composer/timeline and docs | commit: `fd73503`.
- T3 | S1-S4 | route: inline checks and work-unit commit | done: focused/full tests, build, corrected whitespace and staged-diff isolation observed | commit: `fd73503`; this closing record is a separate documentation commit.

## Log

L1 — Original request (verbatim):

https://code.claude.com/docs/en/vs-code

investiga la doc para saber mas de como armar la extension nuestra..

C:\Users\lucas\AppData\Local\Temp\gpu8pLfE\pi-clipboard-8f357032-b5fa-4e44-9a61-114d7d5868b3.png

ademas de tener una ui muy similar pero otro color

C:\Users\lucas\AppData\Local\Temp\gpu8pLfE\pi-clipboard-e81dfd83-d74c-4226-8362-0b6d89941132.png

se entiende ? trabaja en eso

L2 — Research: https://code.claude.com/docs/en/vs-code documents history, model selection, editor context, permissions, diffs, multiple surfaces and activity visibility. OpenCode 1.19.0 is the behavior authority: no fabricated Claude modes, account integration, queues, effort controls or administrative MCP actions. Both user-provided images were viewed; no proprietary package/code/assets were inspected or copied.
L3 — Existing uncommitted diagnostics, protocol, execution-error and history fixes are outside this work unit and must be preserved. The earlier feature's Engram topic currently contains a bugfix summary rather than its full tracker; use the repository tracker for earlier milestone evidence and keep this feature's mirror separate.
L6 — Read-only risk assessment could not form a native candidate because the new tracker was untracked. RDD remains off; the returned fallback plan requires writer self-verification and no independent verifier. Existing checks above are the evidence; no review approval is claimed. The staged feature contains only this unit (6 paths, approximately 240 authored lines), excluding all prior pending diagnostics/history/execution fixes.
L5 — RED: two new markup regressions failed (exit 1), demonstrating absent native history/settings disclosures and empty identity. GREEN: focused Webview suite 24 passed (exit 0); full suite 12 files, 243 passed / 1 gated smoke skipped (exit 0). Build job-17 passed typecheck, Webview and Extension Host builds (exit 0). Existing Vite config-loader warning and Windows LF/CRLF warnings remain; the staged whitespace check initially rejected five trailing spaces copied from the request; those line-ending spaces were removed without changing its words. No CLI flags, parsers, shared contracts, transport, permissions or inference configuration changed; CLI differential testing is not applicable. Risk: none for this presentation-only unit; no security decision or server action is moved inside a collapsed disclosure.
L4 — No Playwright/Puppeteer dependency or browser automation tool is available. Deterministic markup/interaction-contract checks and compilation are available; live Extension Host appearance, light/dark/high-contrast rendering and pixel similarity remain manual checks, not claimed evidence.
