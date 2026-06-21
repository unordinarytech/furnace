export type Skill = {
  baseDir: string
  content: string
  description: string
  disableModelInvocation: boolean
  filePath: string
  name: string
  provenance: string
  root: string
}

export type SkillDiagnostic = {
  message: string
  path: string
}

export type SkillCatalog = {
  diagnostics: SkillDiagnostic[]
  skills: Skill[]
}
