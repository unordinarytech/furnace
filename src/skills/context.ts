import { pathToFileURL } from "node:url"
import type { Skill } from "./types.js"

export function appendSkillGuidance(systemPrompt: string, skills: Skill[]): string {
  const visible = skills.filter((skill) => !skill.disableModelInvocation)
  return [systemPrompt.trimEnd(), "", renderSkillGuidance(visible)].join("\n")
}

export function renderSkillGuidance(skills: Skill[]): string {
  return [
    "Skills provide specialized instructions and workflows for specific tasks.",
    "Use the `skill` tool to load a skill when a task matches its description.",
    skills.length === 0
      ? "No skills are currently available."
      : [
          "<available_skills>",
          ...skills.flatMap((skill) => [
            "  <skill>",
            `    <name>${escapeXml(skill.name)}</name>`,
            `    <description>${escapeXml(skill.description)}</description>`,
            `    <provenance>${escapeXml(skill.provenance)}</provenance>`,
            "  </skill>",
          ]),
          "</available_skills>",
        ].join("\n"),
  ].join("\n")
}

export function renderSkillToolOutput(skill: Skill, files: string[]): string {
  return [
    `<skill_content name="${escapeXml(skill.name)}">`,
    `# Skill: ${skill.name}`,
    "",
    skill.content.trim(),
    "",
    `Provenance: ${skill.provenance}`,
    `Base directory for this skill: ${pathToFileURL(skill.baseDir).href}`,
    "Relative paths in this skill are relative to this base directory.",
    "Note: file list is sampled.",
    "",
    "<skill_files>",
    ...files.map((file) => `<file>${escapeXml(file)}</file>`),
    "</skill_files>",
    "</skill_content>",
  ].join("\n")
}

export function renderSkillInvocationMessage(skill: Skill, userInstruction: string): string {
  return [
    `[IMPORTANT: The user has invoked the ${skill.name} skill. The full skill content is loaded below.]`,
    "",
    renderSkillToolOutput(skill, []),
    "",
    userInstruction.trim()
      ? `User instruction: ${userInstruction.trim()}`
      : "The user did not provide an extra instruction. Ask what they want to do with this skill if the next step is unclear.",
  ].join("\n")
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
}
