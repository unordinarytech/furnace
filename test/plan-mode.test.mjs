import assert from "node:assert/strict"
import { test } from "node:test"
import {
  appendPlanModeGuidance,
  createPlanPath,
  currentPlanModeState,
  renderPlanExecutionPrompt,
  renderVisiblePlanArtifact,
} from "../dist/plan-mode.js"

test("plan paths use the durable Furnace plans directory", () => {
  const path = createPlanPath("/tmp/project", "Add auth & sessions", new Date("2026-06-22T12:15:30.000Z"))

  assert.equal(path, ".furnace/plans/2026-06-22_174530-add-auth-sessions.md")
})

test("current plan mode is reconstructed from custom session entries", () => {
  const entries = [
    {
      id: "entry-1",
      parentEntryId: null,
      sessionId: "session-1",
      type: "custom",
      role: null,
      data: { kind: "mode_change", mode: "plan", planPath: ".furnace/plans/plan.md" },
      createdAt: 0,
    },
    {
      id: "entry-2",
      parentEntryId: "entry-1",
      sessionId: "session-1",
      type: "custom",
      role: null,
      data: { kind: "mode_change", mode: "agent" },
      createdAt: 1,
    },
  ]

  assert.deepEqual(currentPlanModeState(entries), { mode: "agent" })
})

test("plan guidance requires the artifact and concrete implementation details", () => {
  const guidance = appendPlanModeGuidance("base system", {
    mode: "plan",
    planPath: ".furnace/plans/plan.md",
  })

  assert.match(guidance, /Plan mode is active/)
  assert.match(guidance, /only writable artifact is the plan file: \.furnace\/plans\/plan\.md/)
  assert.match(guidance, /exact file paths/)
  assert.match(guidance, /commands\/tests\/verification/)
})

test("execution prompt points the agent back to the durable plan file", () => {
  const prompt = renderPlanExecutionPrompt(".furnace/plans/plan.md")

  assert.match(prompt, /approved the plan at \.furnace\/plans\/plan\.md/)
  assert.match(prompt, /Read the plan file/)
  assert.match(prompt, /normal agent mode/)
})

test("visible plan artifact renders the saved markdown plan for review", () => {
  const rendered = renderVisiblePlanArtifact(
    "Plan created.",
    ".furnace/plans/plan.md",
    "# Build Plan\n\n- Inspect `src/cli.ts`\n- Run `npm test`\n",
  )

  assert.match(rendered, /Plan created\./)
  assert.match(rendered, /## Saved Plan/)
  assert.match(rendered, /Path: `\.furnace\/plans\/plan\.md`/)
  assert.match(rendered, /# Build Plan/)
  assert.match(rendered, /Run `npm test`/)
})
