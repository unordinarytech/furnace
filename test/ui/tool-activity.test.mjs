import { describe, it } from "node:test"
import assert from "node:assert"
import { resolveTheme } from "../../dist/ui/terminal-themes/index.js"
import { ToolActivityComponent } from "../../dist/ui/pi-components/tool-activity.js"

describe("ToolActivityComponent", () => {
  const theme = resolveTheme("flexoki").theme

  it("renders a running tool with an icon and name", () => {
    const component = new ToolActivityComponent({ id: "1", name: "bash", status: "running", args: "ls" }, theme)
    const lines = component.render(40)
    assert.ok(lines.length > 0)
    assert.ok(lines.some((line) => line.includes("bash")))
    assert.ok(lines.some((line) => line.includes("ls")))
  })

  it("renders a failed tool with the result", () => {
    const component = new ToolActivityComponent(
      { id: "2", name: "write", status: "failed", args: "file.ts", result: "permission denied" },
      theme,
    )
    const lines = component.render(40)
    assert.ok(lines.some((line) => line.includes("permission denied")))
  })

  it("updates when setActivity is called", () => {
    const component = new ToolActivityComponent({ id: "3", name: "grep", status: "running", args: "foo" }, theme)
    component.setActivity({ id: "3", name: "grep", status: "done", args: "foo", result: "3 matches" })
    const lines = component.render(40)
    assert.ok(lines.some((line) => line.includes("3 matches")))
  })
})
