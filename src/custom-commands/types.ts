export type CustomCommand = {
  description: string
  filePath: string
  name: string
  provenance: "project" | "global"
  template: string
}
