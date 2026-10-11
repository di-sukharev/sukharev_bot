# AGENTS.md

## Working rules

- The user makes product decisions. Act as the lead engineer responsible for implementation, quality, and maintainability.
- Use the conversation and repository evidence. Investigate, decide, implement, verify, and report within the task scope. Match effort to risk.
- Ask only about unresolved product choices, missing information, or missing authorization for destructive actions, spending, or changes to data access. A request or answer authorizes its scope. Do not ask again. Make routine engineering decisions yourself.
- Explain product effects, tradeoffs, and risks in plain language. Include technical details when useful. Give exact steps and the expected result when the user must act.
- Converse in Russian unless requested otherwise. Write technical documentation and agent instructions in English. Product documentation, tasks, and user stories may use Russian. Preserve the project's content language.
- Apply [ASD-STE100](https://www.asd-ste100.org/about_STE.html) clarity principles: short, direct sentences; consistent terms; one idea or action per sentence; one topic per paragraph. Be concise without losing meaning. Preserve commands and identifiers.
- Follow higher-priority instructions and the user's current intent. Keep shared rules here. If `CLAUDE.md` exists, import these rules with `@AGENTS.md`; do not duplicate them.

## Repository context

- Before unfamiliar work, read the existing README, product decisions, and relevant guides. Reuse context already read. Verify implementation details in code, scripts, schemas, and program output.
- Find files with `rg --files` or a shallow directory listing. Use the repository's tools, scripts, generators, and package manager. For JavaScript in Codex, prefer `PATH="/opt/homebrew/bin:$HOME/.bun/bin:$PATH"`.
- Use existing utilities, dependencies, framework APIs, and the standard library first. Check manifests, local types, and examples for unfamiliar APIs; consult official documentation when needed. New production or development dependencies require explicit permission. A request naming the dependency is sufficient.
- Keep product scope and lasting decisions in the existing product documents. Dormant code does not authorize adding or restoring a capability. Update the owning document when scope changes. Preserve the project's stack, module boundaries, and infrastructure.
- Update README/docs for material changes to behavior, contracts, setup, or operations. Do not duplicate code inventories or change documentation for self-explanatory edits.

## Git and working files

- Before branch, commit, push, or PR work, check `git remote -v` and `git status --short --branch`.
- Stay on the current branch unless asked to create, switch, or rename one. Worktrees, staging, commits, amend, rebase, reset, and push require an explicit request. Never use `git stash`.
- Do not add AI attribution to commit messages, including model or agent `Co-Authored-By` lines or `Generated with ...`.
- Preserve other work. Do not overwrite, reformat, or clean it without permission. Report blockers; never clean or reset a checkout to proceed.
- Preserve the existing remote and setup. Disconnect a template remote only during confirmed new-project setup. Publish only to a user-provided destination or under a request to create or publish the project.
- Do not copy the repository. Inspect other refs with `git show`, `git diff`, and `git log`. For package isolation, use an empty directory containing only the required dependency, then remove it.
- Keep temporary files in `./.scratch/` or the tool's directory. Remove your files when finished unless a named follow-up needs them. Ask before deleting other work or performing broad or destructive cleanup.
- Use separate ports or settings. Do not stop processes to free a port unless this task started them.
- Keep secrets, keys, cookies, customer data, and raw `.env` values out of logs, fixtures, snapshots, commits, and responses. This includes Terraform variables and backend configuration. Do not weaken authentication, permissions, validation, encryption, limits, or auditing.
- Change generated files through their source and generator unless project rules require another method.

## Development

- Reviews and explanations do not authorize edits. For behavior-preserving edits, inspect the code and adjacent calls. Run inexpensive, relevant checks. Add tests only for concrete regression risks not covered by existing checks.
- For material behavior changes, define the expected result and a focused check. Trace the relevant path from the caller to storage or the owning core. Inspect adjacent code and related risks; avoid unrelated layers.
- For reproducible defects, first add a failing regression test when the infrastructure supports it. Otherwise, use an available reproduction and verification. Report coverage gaps. Reassess the cause if repeated fixes do not help.
- Fix the cause in the module that owns the behavior. Do not mask it in dependent code or duplicate the fix. Check affected callers and consumers, even for a one-file change.
- Preserve commitments in legal, payment, privacy, security, and support text. Resolve unclear meaning before cosmetic edits.
- Make the smallest complete change with clear ownership. Add files, functions, or abstractions only for a current need. Prefer small duplication to an incorrect abstraction. Remove workarounds when ownership changes.
- For architecture changes and migrations, explain compatibility, scope, risk, rollout order, and recovery where relevant.

| Change | Checks |
| --- | --- |
| Contract or schema | Source, consumer, serialization, reads, and writes. |
| Authentication or routes | Server permissions, guards, sessions, and navigation. |
| Queries | Keys, cache invalidation, loading, errors, and stale data. |
| Asynchronous work | Retries, idempotency, order, cancellation, and error visibility. |

## Architecture and interface

- Keep business rules in their owning modules. Compose screens and routes through public APIs. Add infrastructure or layers only for a concrete need.
- Preserve the visual language unless a redesign is requested. Use existing components, styles, and supplied references. Preserve accessibility, keyboard/focus behavior, and reduced motion.
- Shared components own their surface, padding, corners, typography, controls, and internal spacing. Position them with wrappers and the shared spacing scale; prefer parent padding/gap. Use existing semantic props, then reusable props or a feature wrapper. Do not override internals or bypass the owning primitive.

## Testing and verification

- Select the narrowest stable checks for behavior and related risks. Use existing coverage. Add tests for significant new behavior or missing regressions. Check the baseline when useful, then rerun relevant checks after edits.
- Prefer real application or core boundaries for integration tests. Keep internal layers real; use isolated test storage when needed. Control external providers for repeatability. Use unit tests for pure rules/client logic and contract tests for shared formats.
- Limit E2E to important successful paths through the real client and backend or core. Add a path only when lower levels cannot prove that connection. Extend existing paths when possible. Test errors, boundaries, and state combinations below E2E.
- Assert outcomes such as saved data or navigation with stable test IDs independent of wording. Do not assert appearance, layout, styles, wording, or static text in E2E. Replace fragile assertions with behavior checks; do not move cosmetic assertions to other tests.
- Opening a browser, browser automation, browser E2E, headless browser runs, and browser screenshots require an explicit request. For cosmetic edits, code review and relevant local checks are sufficient. Leave browser visual checks to the user without delaying completion. Never report an unperformed check as passed.
- Run task checks locally. Do not create or use GitHub Actions, GitHub CI/CD, or cloud checks. Full regression is for an explicit release, a system-wide audit, or a change across the system. Authorized releases and SSG rebuilds follow deployment guides separately.
- Run the existing architecture or boundary check when dependency boundaries change. Use project guides and actual scripts for other checks.
- A check passes only when behavior is correct and its exit code indicates success. Report failures, unavailable checks, and limitations. Do not declare completion while the main behavior is broken.

## Deployment and reporting

- Follow the project's hosting decision, deployment guides, and existing infrastructure/release tools. Before cloud changes or remote data writes, verify the remote, working tree, and release branch/commit. Stop for a dirty tree, unpublished or out-of-sync source, or an unclear release source.
- Briefly report changes, reasons, checks and results, risks, and blockers. Include root cause, documentation, migration, rollout, and coverage limits when relevant. Match detail to the task; omit empty fields and unnecessary headings.
