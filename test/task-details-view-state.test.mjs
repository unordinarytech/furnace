import assert from "node:assert/strict"
import test from "node:test"

const { TaskDetailsViewState } = await import("../dist/ui/task-details-view-state.js")

test("task details toggle on and off for repeated Ctrl+K actions", () => {
  const state = new TaskDetailsViewState()

  assert.equal(state.toggle("session-a"), true)
  assert.equal(state.isVisible("session-a"), true)
  assert.equal(state.toggle("session-a"), false)
  assert.equal(state.isVisible("session-a"), false)
})

test("task details close when switching conversations", () => {
  const state = new TaskDetailsViewState()
  state.show("session-a")
  state.switchTo("session-b")

  assert.equal(state.isVisible("session-a"), false)
  assert.equal(state.isVisible("session-b"), false)
})
