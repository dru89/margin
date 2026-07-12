# Margin

**Write in markdown. Review in the margin.**

Margin is a desktop editor where you and Claude work on a document the way
engineers review a pull request: anchored comments, concrete suggestions you
accept or reject one by one, in deliberate rounds. Your files stay plain
markdown — on your disk, in your git history, no lock-in.

![Margin reviewing a document — suggestions render inline like tracked
changes, with comment threads and a project discussion in the
sidebar](site/img/hero-light.png)

## How it works

1. **Write.** Open a markdown file or folder. Margin is a focused editor with
   a live preview — edit normally, it autosaves.
2. **Comment.** Select any passage and attach a comment (Cmd/Ctrl+M, or
   right-click). Use the **Discussion** dock for the bigger picture — who the
   document is for, what good looks like. Reference other files as
   `@path/to/file.md`; invoke a project skill as `/name`.
3. **Submit a round.** Margin checkpoints your work to git, then hands the
   document to Claude. It reads the whole project — your reference material
   included — answers every open thread, and files its edits as suggestions.
4. **Decide what lands.** Suggestions render inline like tracked changes:
   the original struck through, the replacement beside it. Accept or reject
   each one — from the card, or right on the text. Rejections carry your
   reasoning into the next round, so it doesn't ask twice.
5. **Repeat** until neither of you has anything meaningful left to say.

The agent can never edit your file directly. Every change lands through a
suggestion you accepted, and every round is committed to git — the
document's history reads like a changelog of decisions.

## What's in the box

- **Anchored comments** that follow their text through edits (yours or
  anyone's) and survive as "orphaned" instead of silently dying when the
  text is deleted
- **Inline suggestions** in the document itself, Google-Docs style, plus a
  triage queue in the sidebar
- **A project-level discussion** shared across every document in the
  workspace — framing you write once shapes every future round
- **A workspace explorer** with open-thread counts and modified-since-commit
  markers; non-markdown files open in their native apps
- **Git built in**: automatic checkpoints around every round, a history
  browser, and one-click restore to any earlier version (itself
  checkpointed, so it's reversible)
- **File watching**: edit your documents in any other tool while Margin is
  open — clean reloads happen silently, conflicts ask you
- **`(TK: …)` markers** as a fallback comment channel for edits made outside
  Margin — the agent answers them and proposes replacements
- Model picker per round · Catppuccin Latte/Mocha themes · in-app updates

## Install

Grab the [latest release](https://github.com/Dru89/margin/releases/latest) —
dmg for macOS, AppImage or pacman package for Linux.

You'll need [Claude Code](https://claude.com/claude-code) logged in
(`claude` CLI) — review rounds run on your existing Claude subscription.
Margin never touches API keys.

To build from source, see [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

## Your files stay yours

The document is a normal `.md` file. Review state (threads, suggestions)
lives in a readable JSON sidecar next to it; the project discussion lives in
`.margin/discussion.json` at the workspace root. Delete Margin and every
word you wrote — and every decision you made — is still right there in your
repo.

---

MIT © Drew Hays · built on the
[Claude Agent SDK](https://platform.claude.com/docs/en/agent-sdk/overview) ·
[Why is it built this way?](DECISIONS.md)
