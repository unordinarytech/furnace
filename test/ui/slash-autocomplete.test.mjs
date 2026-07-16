import { describe, it } from "node:test"
import assert from "node:assert"
import { SlashCommandAutocompleteProvider } from "../../dist/ui/pi/slash-autocomplete.js"

describe("SlashCommandAutocompleteProvider", () => {
  it("returns null when line does not start with /", async () => {
    const provider = new SlashCommandAutocompleteProvider([
      { value: "/login", label: "Login", description: "Set API key" },
    ])
    const result = await provider.getSuggestions(["hello"], 0, 5)
    assert.strictEqual(result, null)
  })

  it("returns matching slash commands for prefix", async () => {
    const provider = new SlashCommandAutocompleteProvider([
      { value: "/login", label: "Login", description: "Set API key" },
      { value: "/model", label: "Model", description: "Pick a model" },
      { value: "/theme", label: "Theme", description: "Change theme" },
    ])
    const result = await provider.getSuggestions(["/lo"], 0, 3)
    assert.ok(result)
    assert.strictEqual(result.items.length, 1)
    assert.strictEqual(result.items[0].value, "/login")
    assert.strictEqual(result.items[0].label, "Login")
  })

  it("fuzzy-filters command arguments like pi", async () => {
    const provider = new SlashCommandAutocompleteProvider([
      { value: "/model anthropic/claude-sonnet-4-6", label: "Claude Sonnet 4.6", description: "1M context" },
      { value: "/model openai/gpt-5.5", label: "GPT-5.5", description: "400k context" },
      { value: "/model google/gemini-3-pro", label: "Gemini 3 Pro", description: "2M context" },
    ])

    // Substring of the id, not a prefix of the value — must still match,
    // and the closest match must rank first.
    const line = "/model gpt"
    const result = await provider.getSuggestions([line], 0, line.length)
    assert.ok(result)
    assert.ok(result.items.length >= 1)
    assert.strictEqual(result.items[0].value, "/model openai/gpt-5.5")
    assert.strictEqual(result.prefix, line)

    // Fuzzy (non-contiguous) match against the label.
    const fuzzyLine = "/model snnet"
    const fuzzy = await provider.getSuggestions([fuzzyLine], 0, fuzzyLine.length)
    assert.ok(fuzzy)
    assert.strictEqual(fuzzy.items[0].value, "/model anthropic/claude-sonnet-4-6")

    // Empty argument lists every candidate for the command.
    const all = await provider.getSuggestions(["/model "], 0, 7)
    assert.ok(all)
    assert.strictEqual(all.items.length, 3)

    // No match yields null so the popup closes.
    const none = await provider.getSuggestions(["/model zzzzqq"], 0, 13)
    assert.strictEqual(none, null)
  })

  it("fuzzy-searches hidden conversation content without displaying it", async () => {
    const provider = new SlashCommandAutocompleteProvider([
      {
        value: "/resume 1",
        label: "Fix checkout",
        description: "2 minutes ago",
        searchText: "user investigate the intermittent websocket reconnect failure",
      },
      {
        value: "/resume 2",
        label: "Update docs",
        description: "1 hour ago",
        searchText: "user document the release process",
      },
    ])

    const line = "/resume wbskt"
    const result = await provider.getSuggestions([line], 0, line.length)
    assert.ok(result)
    assert.strictEqual(result.items.length, 1)
    assert.strictEqual(result.items[0].value, "/resume 1")
    assert.strictEqual(result.items[0].searchText.includes("websocket"), true)
  })

  it("applies argument completion by replacing the whole command line", () => {
    const provider = new SlashCommandAutocompleteProvider([
      { value: "/model openai/gpt-5.5", label: "GPT-5.5" },
    ])
    const applied = provider.applyCompletion(
      ["/model gpt"], 0, 10,
      { value: "/model openai/gpt-5.5", label: "GPT-5.5" },
      "/model gpt",
    )
    assert.strictEqual(applied.lines[0], "/model openai/gpt-5.5")
    assert.strictEqual(applied.cursorCol, "/model openai/gpt-5.5".length)
  })

  it("applies completion by replacing prefix", () => {
    const provider = new SlashCommandAutocompleteProvider([
      { value: "/login", label: "Login" },
    ])
    const applied = provider.applyCompletion(["/lo"], 0, 3, { value: "/login", label: "Login" }, "/lo")
    assert.strictEqual(applied.lines[0], "/login")
    assert.strictEqual(applied.cursorLine, 0)
    assert.strictEqual(applied.cursorCol, 6)
  })

  it("calls onTab and skips default apply when handler returns true", () => {
    let called = false
    const provider = new SlashCommandAutocompleteProvider(
      [{ value: "/history", label: "History" }],
      (match) => {
        called = true
        assert.strictEqual(match.value, "/history")
        assert.strictEqual(match.selected, true)
        return true
      },
    )
    const applied = provider.applyCompletion(["/hi"], 0, 3, { value: "/history", label: "History" }, "/hi")
    assert.strictEqual(called, true)
    assert.strictEqual(applied.lines[0], "/hi")
    assert.strictEqual(applied.cursorCol, 3)
  })
})
