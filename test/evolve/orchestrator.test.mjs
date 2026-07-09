import test from "node:test"
import assert from "node:assert/strict"

function makeEngine(overrides = {}) {
  const calls = []
  const base = {
    createRecoveryPoint: (root, description) => { calls.push("snapshot"); return { id: "abc123", furnaceRoot: root, description } },
    recordCreatedFiles: (id, files) => { calls.push(`record:${files.join(",")}`) },
    restoreRecoveryPoint: (id) => { calls.push(`restore:${id}`); return { ok: true } },
    listNewFiles: () => [],
    verifyToTemp: async () => { calls.push("verify"); return { ok: true, build: { ok: true, log: "built" } } },
    performSwap: () => { calls.push("swap") },
    gitDiff: () => "diff --git a/x b/x",
    runningBinMatchesRoot: () => true,
  }
  return { engine: { ...base, ...overrides }, calls }
}

function makeInteraction(overrides = {}) {
  const events = []
  const base = {
    notify: (message) => events.push(`notify:${message}`),
    confirmApply: async () => { events.push("confirm"); return true },
    runEditTurn: async () => { events.push("edit") },
  }
  return { interaction: { ...base, ...overrides }, events }
}

const availableRoot = { available: true, root: "/furnace" }

test("runEvolve applies in order: snapshot -> edit -> verify -> confirm -> swap", async () => {
  const { runEvolve } = await import("../../dist/evolve/orchestrator.js")
  const { engine, calls } = makeEngine()
  const { interaction, events } = makeInteraction()
  const outcome = await runEvolve({ request: "add cost to statusline", rootResult: availableRoot, interaction, engine })

  assert.equal(outcome.status, "applied")
  assert.equal(outcome.recoveryId, "abc123")
  // Snapshot strictly before verify strictly before swap.
  const ordered = calls.filter((c) => ["snapshot", "verify", "swap"].includes(c))
  assert.deepEqual(ordered, ["snapshot", "verify", "swap"])
  // Created files recorded before verify.
  assert.ok(calls.findIndex((c) => c.startsWith("record:")) < calls.indexOf("verify"))
  // edit happens between snapshot and verify; confirm before swap.
  assert.ok(events.indexOf("edit") < events.indexOf("confirm"))
  assert.ok(events.some((e) => e.startsWith("notify:Applied and verified")))
})

test("runEvolve rolls back and does not swap when verification fails", async () => {
  const { runEvolve } = await import("../../dist/evolve/orchestrator.js")
  const { engine, calls } = makeEngine({ verifyToTemp: async () => ({ ok: false, step: "smoke", log: "crash on import" }) })
  const { interaction, events } = makeInteraction()
  const outcome = await runEvolve({ request: "break things", rootResult: availableRoot, interaction, engine })

  assert.equal(outcome.status, "verify-failed")
  assert.equal(outcome.step, "smoke")
  assert.equal(calls.includes("swap"), false)
  assert.ok(calls.includes("restore:abc123"))
  assert.equal(events.includes("confirm"), false)
})

test("runEvolve rolls back when the user rejects the diff", async () => {
  const { runEvolve } = await import("../../dist/evolve/orchestrator.js")
  const { engine, calls } = makeEngine()
  const { interaction } = makeInteraction({ confirmApply: async () => false })
  const outcome = await runEvolve({ request: "add a widget", rootResult: availableRoot, interaction, engine })

  assert.equal(outcome.status, "rejected")
  assert.equal(calls.includes("swap"), false)
  assert.ok(calls.includes("restore:abc123"))
})

test("runEvolve applies a theme preference only for theme requests", async () => {
  const { runEvolve } = await import("../../dist/evolve/orchestrator.js")
  let themed = 0
  const { engine } = makeEngine()
  const { interaction } = makeInteraction({ applyThemePreference: async () => { themed += 1 } })
  await runEvolve({ request: "add a monochrome green theme", rootResult: availableRoot, interaction, engine })
  assert.equal(themed, 1)

  const { engine: engine2 } = makeEngine()
  const { interaction: interaction2 } = makeInteraction({ applyThemePreference: async () => { themed += 1 } })
  await runEvolve({ request: "change thinking text to huzzing", rootResult: availableRoot, interaction: interaction2, engine: engine2 })
  assert.equal(themed, 1)
})

test("runEvolve warns when the running bin is outside the root", async () => {
  const { runEvolve } = await import("../../dist/evolve/orchestrator.js")
  const { engine } = makeEngine({ runningBinMatchesRoot: () => false })
  const { interaction, events } = makeInteraction()
  const outcome = await runEvolve({ request: "add cost", rootResult: availableRoot, interaction, engine })
  assert.equal(outcome.runningBinMatchesRoot, false)
  assert.ok(events.some((e) => e.includes("appears to live elsewhere")))
})

test("runEvolve returns unavailable without touching git when source is missing", async () => {
  const { runEvolve } = await import("../../dist/evolve/orchestrator.js")
  const { engine, calls } = makeEngine()
  const { interaction } = makeInteraction()
  const outcome = await runEvolve({
    request: "x",
    rootResult: { available: false, reason: "no-source", message: "no source" },
    interaction,
    engine,
  })
  assert.equal(outcome.status, "unavailable")
  assert.deepEqual(calls, [])
})
