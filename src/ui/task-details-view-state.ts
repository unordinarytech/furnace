export class TaskDetailsViewState {
  private sessionId: string | undefined

  isVisible(sessionId: string): boolean {
    return this.sessionId === sessionId
  }

  show(sessionId: string): void {
    this.sessionId = sessionId
  }

  toggle(sessionId: string): boolean {
    if (this.sessionId === sessionId) {
      this.sessionId = undefined
      return false
    }
    this.sessionId = sessionId
    return true
  }

  switchTo(sessionId: string): void {
    if (this.sessionId !== sessionId) this.sessionId = undefined
  }
}
