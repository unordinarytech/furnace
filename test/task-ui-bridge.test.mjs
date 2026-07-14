import assert from "node:assert/strict"
import test from "node:test"
import { createSessionTerminalBridge } from "../dist/task-ui-bridge.js"

test("background session cost updates cannot mutate the visible terminal", () => {
  const costs = []
  let visible = false
  const bridge = createSessionTerminalBridge({
    base: {
      setCostUsage(value) {
        costs.push(value)
      },
    },
    isVisible: () => visible,
    pendingApprovals: new Map(),
    pendingPlanActions: new Map(),
    pendingQuestions: new Map(),
    runtimeUi: new Map(),
    targetSessionId: "background-session",
  })

  bridge.setCostUsage(1.25)
  assert.deepEqual(costs, [])

  visible = true
  bridge.setCostUsage(2.5)
  assert.deepEqual(costs, [2.5])
})
