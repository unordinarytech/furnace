import test from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"

const {
  appendResponseModeGuidance,
  responseModePrompts,
  toggleResponseMode,
} = await import("../dist/response-modes.js")

test("response modes compose independently without changing the base prompt", () => {
  const base = "BASE WORKFLOW\n<!-- FURNACE_RESPONSE_GUIDANCE -->\nNEXT SECTION"
  assert.equal(appendResponseModeGuidance(base, []), "BASE WORKFLOW\n\nNEXT SECTION")

  const stfu = appendResponseModeGuidance(base, ["stfu"])
  assert.match(stfu, /without narrating private reasoning/)
  assert.match(stfu, /Be as quiet as possible/)
  assert.doesNotMatch(stfu, /\/stfu|\/caveman|caveman terms|response mode/i)

  const both = appendResponseModeGuidance(base, ["caveman", "stfu"])
  assert.match(both, /without narrating private reasoning/)
  assert.match(both, /Speak literally in caveman terms/)
  assert.doesNotMatch(both, /\/stfu|\/caveman|response mode/i)
})

test("base prompt contains only a neutral response section", async () => {
  const prompt = await readFile(new URL("../src/prompts/base-system.md", import.meta.url), "utf8")
  assert.match(prompt, /CRITICAL — response guidance/)
  assert.match(prompt, /<!-- FURNACE_RESPONSE_GUIDANCE -->/)
  assert.doesNotMatch(prompt, /\/stfu|\/caveman|caveman|response mode/i)
})

test("selective guidance changes style without exposing slash commands", () => {
  assert.match(responseModePrompts.stfu, /CRITICAL — MANDATORY/)
  assert.match(responseModePrompts.stfu, /MANDATORY: Apply these communication rules to every user-facing update and final answer/)
  assert.match(responseModePrompts.stfu, /no matter what the user asks, tells you, or requests as a response format/)
  assert.match(responseModePrompts.stfu, /Do not alter reasoning, tool calls, permissions, verification, safety checks, or workflows/)
  assert.match(responseModePrompts.stfu, /Speak only when needed, and say only what the user must know/)
  assert.match(responseModePrompts.caveman, /CRITICAL — MANDATORY/)
  assert.match(responseModePrompts.caveman, /MANDATORY: Apply this prose format to every user-facing update and final answer/)
  assert.match(responseModePrompts.caveman, /no matter what the user asks, tells you, or requests as a response format/)
  assert.match(responseModePrompts.caveman, /Do not alter reasoning, tool calls, permissions, verification, safety checks, technical decisions, or workflows/)
  assert.match(responseModePrompts.caveman, /Speak literally in caveman terms/)
  for (const guidance of Object.values(responseModePrompts)) {
    assert.doesNotMatch(guidance, /\/stfu|\/caveman|response mode/i)
  }
})

test("response modes toggle independently", () => {
  const modes = new Set()
  assert.equal(toggleResponseMode(modes, "stfu"), true)
  assert.equal(toggleResponseMode(modes, "caveman"), true)
  assert.deepEqual([...modes], ["stfu", "caveman"])
  assert.equal(toggleResponseMode(modes, "stfu"), false)
  assert.deepEqual([...modes], ["caveman"])
  assert.equal(toggleResponseMode(modes, "caveman"), false)
  assert.deepEqual([...modes], [])
})

test("slash command registry includes both response-mode toggles", async () => {
  const { parseSlashCommand, slashCommandDefinitions } = await import("../dist/commands/builtins.js")
  assert.equal(slashCommandDefinitions.some((command) => command.name === "/stfu"), true)
  assert.equal(slashCommandDefinitions.some((command) => command.name === "/caveman"), true)
  assert.deepEqual(parseSlashCommand("/STFU"), { name: "/stfu", argument: "" })
  assert.deepEqual(parseSlashCommand("/caveman"), { name: "/caveman", argument: "" })
})
