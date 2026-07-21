import assert from "node:assert/strict"
import test from "node:test"

test("usage view consumes only the first dismiss action", async () => {
  const { UsageViewState } = await import("../dist/ui/usage-view-state.js")
  const state = new UsageViewState()
  assert.equal(state.dismiss(), false)
  state.show()
  assert.equal(state.visible, true)
  assert.equal(state.dismiss(), true)
  assert.equal(state.visible, false)
  assert.equal(state.dismiss(), false)
})

test("interrupt and startup copy stay concise and accurate", async () => {
  const [{ INTERRUPTED_MESSAGE, MISSING_API_KEY_NOTICE, isWorkingSessionNavigationCommand }, { COMPACT_STARTUP_HINT }] = await Promise.all([
    import("../dist/interactive-session-controller.js"),
    import("../dist/ui/pi/layouts.js"),
  ])
  assert.equal(INTERRUPTED_MESSAGE, "Interrupted.")
  assert.equal(MISSING_API_KEY_NOTICE, "No API key configured. Use /login to configure API keys.")
  assert.equal(COMPACT_STARTUP_HINT, "ctrl+c interrupt/close · / commands")
  assert.doesNotMatch(INTERRUPTED_MESSAGE, /queued prompt/i)
  assert.doesNotMatch(COMPACT_STARTUP_HINT, /ctrl\+d|ctrl\+o|drop files/i)
  assert.equal(isWorkingSessionNavigationCommand("/new"), true)
  assert.equal(isWorkingSessionNavigationCommand("/resume"), true)
  assert.equal(isWorkingSessionNavigationCommand("/history"), true)
  assert.equal(isWorkingSessionNavigationCommand("/model"), false)
})
