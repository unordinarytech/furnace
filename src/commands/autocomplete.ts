import { slashCommandDefinitions } from "./builtins.js"
import type { CustomCommand } from "./custom/types.js"
import type { Skill } from "../skills/types.js"
import type { PromptAutocompleteItem } from "../ui/terminal-types.js"

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
    ...skills.flatMap((skill) => [
      {
        description: skill.description,
        insertText: `/skill:${skill.name} `,
        label: `/${skill.name}`,
        value: `/${skill.name}`,
      },
      {
      browsable: true,
      description: skill.description,
      label: `/skill:${skill.name}`,
      insertText: `/skill:${skill.name} `,
      value: `/skill:${skill.name}`,
      },
    ]),
  ]
}

export function isSkillCommand(commandName: string): boolean {
  return commandName.startsWith("/skill:") && commandName.length > "/skill:".length
}
