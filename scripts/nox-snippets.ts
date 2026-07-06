// voidarch-context snippets — print a ready-to-paste Claude Code slash-command
// snippet and an AGENTS.md snippet for wiring `voidarch-context` into a target
// repo's agent workflow. No DB access, no args needed.

const SLASH_COMMAND = `---
description: Build a Voidarch Context pack for the current task
---

Run \`npx voidarch-context context "$ARGUMENTS"\` and use the Markdown output as
context for the rest of this task. If it reports open blockers or required
approvals, surface those to the user before proceeding.
`;

const AGENTS_MD = `## Voidarch Context memory

This repo uses Voidarch Context for local repo memory and context packs. Before
non-trivial tasks, run:

\`\`\`bash
npx voidarch-context context "<short task description>"
\`\`\`

Use the returned Markdown (files, symbols, docs, memories, graph, state) as
grounding context. Record durable facts as you go:

\`\`\`bash
npx voidarch-context remember --kind decision "..."
npx voidarch-context remember --kind lesson "..."
npx voidarch-context remember --kind task_note "..."
\`\`\`

No API key required — Voidarch Context embeds locally by default.
`;

console.log("voidarch-context snippets\n");
console.log("--- Claude Code slash command: .claude/commands/voidarch-context.md ---\n");
console.log(SLASH_COMMAND);
console.log("--- AGENTS.md snippet ---\n");
console.log(AGENTS_MD);
