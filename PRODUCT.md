# Product

<!-- impeccable:product-schema 1 -->

## Platform

web (rendered inside an Electron desktop window on Windows; also runs in a browser via `pnpm dev`)

## Users
One developer (the owner), using it daily on Windows. They hand coding and review work to Claude Code and Codex inside their own local repositories, then decide whether to commit.

## Product Purpose
AI Duo orchestrates two coding agents, Claude Code and Codex, through their local CLIs, using the user's existing subscriptions with no API keys. It offers three modes:
- **Debate:** both agents propose, cross-review each other, and a judge writes the final solution.
- **Pair:** one agent codes in the repo; the other reviews the diff and runs the tests, looping until it approves.
- **Auto:** a router picks the mode, which agent codes, and the models.

Success means the user trusts the result without re-reading everything. They can see at a glance what happened, and they can dig into the reasoning or the diff when they want to.

## Positioning
It is not a single-agent chat. Two different agents check each other's work, and the orchestration is visible: rounds, verdicts, who did what, and the resulting diff.

## Operating Context
- Sessions ("runs") belong to a working directory, usually a git repo. Runs take minutes to tens of minutes and stream live.
- Nothing is committed automatically. The user reviews the diff and commits.
- Runs are stored locally and listed as history.

## Capabilities and Constraints
- UI language is **Vietnamese**. Technical terms (diff, model, commit, prompt, test, token) stay as-is.
- Local only (127.0.0.1). The API rejects cross-origin requests.
- Data shown per run:
  - mode, and the router's plan with its reason;
  - status and rounds;
  - per turn: phase, agent, model plus effort, verdict (AGREE/REVISE/APPROVE/CHANGES_REQUESTED), elapsed time, token usage and cost, and tool calls with their outputs;
  - final solution or result summary;
  - unified diff (Pair mode).
- A run can be cancelled but not continued. A new prompt starts a new run.
- Auto mode sends only `{mode:'auto', prompt, cwd, testCommand, turnTimeoutMin, models}`. It never sends rounds, judge or coder, because those would override the router.

## Brand Commitments
- The product name is "AI Duo". The agents are labelled "Claude" and "Codex", with their established accent colours (Claude orange `#d97757`, Codex green `#10a37f`).
- The layout is modelled on the Codex desktop app, as the user requested. No OpenAI or Anthropic logos or product branding are used beyond the agents' names.

## Evidence on Hand
Real run history is in `%APPDATA%\AI Duo\runs`: a self-review debate and eight pair runs that improved AI Duo itself. There are no testimonials, metrics or external users, so none should be fabricated.

## Product Principles
1. **Progress first, detail on demand.** Current step, who is working and the verdict must be scannable at a glance. The full reasoning, tool output and diff stay one click away (collapsible), never forced on screen.
2. **Both agents are equals.** Neither is visually subordinate, and each is identifiable by name plus colour, not colour alone.
3. **The user stays in control.** Nothing is committed, cancel is always reachable while a run is running, and destructive actions are explicit.
4. **A calm daily tool.** It is used for hours, so it should be quiet, dense enough to scan, and native-feeling, with no decoration that competes with content.

## Accessibility & Inclusion
No product-specific requirement was established. The default target is WCAG AA contrast in both light and dark themes, full keyboard operation of the composer and panels, and respect for `prefers-reduced-motion`.
