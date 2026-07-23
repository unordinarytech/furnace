import { slashCommandDefinitions } from "./builtins.js"
import type { CustomCommand } from "./custom/types.js"
import type { Skill } from "../skills/types.js"
import type { PromptAutocompleteItem } from "../ui/terminal-types.js"

/** Set of builtin slash command names and aliases (without leading /). */
const builtinNames = new Set(
  slashCommandDefinitions.flatMap((cmd) => [cmd.name, ...(cmd.aliases || [])].map((name) => name.slice(1))),
)

export function slashAutocompleteItems(skills: Skill[], customCmds: CustomCommand[] = []): PromptAutocompleteItem[] {
  return [
    ...slashCommandDefinitions.map((command) => ({
      description: command.description,
      insertText: command.insertText,
      label: command.usage || command.name,
      value: command.name,
    })),
    ...customCmds.map((cmd) => ({
      description: cmd.description || `Custom command (${cmd.provenance})`,
      insertText: `/${cmd.name} `,
      label: `/${cmd.name}`,
      value: `/${cmd.name}`,
    })),
    ...skills.flatMap((skill) => {
      const items: PromptAutocompleteItem[] = []
      // Item A: bare /<skillname> (only if no builtin with that name exists).
      // Without this check, selecting the bare version would expand to /<name>
      // which routes to the builtin handler, not the skill.
      if (!builtinNames.has(skill.name)) {
        items.push({
          description: skill.description,
          insertText: `/skill:${skill.name} `,
          label: `/${skill.name}`,
          value: `/${skill.name}`,
        })
      }
      // Item B: explicit /skill:<skillname> invocation (always shown).
      items.push({
        browsable: true,
        description: skill.description,
        label: `/skill:${skill.name}`,
        insertText: `/skill:${skill.name} `,
        value: `/skill:${skill.name}`,
      })
      return items
    }),
  ]
}

export function isSkillCommand(commandName: string): boolean {
  return commandName.startsWith("/skill:") && commandName.length > "/skill:".length
}
