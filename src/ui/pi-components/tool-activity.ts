import { Box, Container, Spacer, Text } from "@earendil-works/pi-tui"
import { bgColor, fgColor } from "./messages.js"
import type { Theme } from "../themes/types.js"
import type { ToolActivity } from "../terminal-types.js"

export class ToolActivityComponent extends Container {
  private activity: ToolActivity
  private theme: Theme

  constructor(activity: ToolActivity, theme: Theme) {
    super()
    this.activity = activity
    this.theme = theme
    this.rebuild()
  }

  setActivity(activity: ToolActivity): void {
    this.activity = activity
    this.rebuild()
  }

  private rebuild(): void {
    this.clear()
    const c = this.theme.colors
    const statusColor =
      this.activity.status === "running" ? c.info : this.activity.status === "failed" ? c.error : c.success
    const statusIcon = this.activity.status === "running" ? "●" : this.activity.status === "failed" ? "✗" : "✓"
    const title = `${statusIcon} ${this.activity.name}`
    const box = new Box(1, 0, bgColor(c.muted))
    box.addChild(new Text(fgColor(statusColor)(title), 0, 0))
    if (this.activity.args) {
      box.addChild(new Text(fgColor(c.mutedForeground)(this.activity.args), 0, 0))
    }
    if (this.activity.result) {
      const resultColor = this.activity.status === "failed" ? c.error : c.mutedForeground
      box.addChild(new Spacer(1))
      box.addChild(new Text(fgColor(resultColor)(this.activity.result), 0, 0))
    }
    this.addChild(box)
  }
}
