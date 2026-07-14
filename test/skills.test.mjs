import assert from "node:assert/strict"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { test } from "node:test"
import { withTemporaryHomeWorkspace } from "./helpers/workspace.mjs"

const withWorkspace = (fn) => withTemporaryHomeWorkspace("furnace-skills-", fn)

async function writeSkill(root, name, frontmatter = "") {
  const dir = join(root, name)
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, "SKILL.md"),
    `---
name: ${name}
description: Skill ${name} description
${frontmatter}---
# ${name}

Use this skill carefully.
`,
  )
}

test("skill loader discovers local skills and hides disabled skills from model guidance", async () => {
  await withWorkspace(async (cwd) => {
    const { appendSkillGuidance } = await import("../dist/skills/context.js")
    const { loadSkills } = await import("../dist/skills/loader.js")
    await writeSkill(join(cwd, ".furnace", "skills"), "visible")
    await writeSkill(join(cwd, ".furnace", "skills"), "manual-only", "disable-model-invocation: true\n")

    const catalog = await loadSkills(cwd)
    assert.deepEqual(catalog.skills.map((skill) => [skill.name, skill.disableModelInvocation]), [
      ["manual-only", true],
      ["visible", false],
    ])

    const guidance = appendSkillGuidance("Base prompt.", catalog.skills)
    assert.match(guidance, /<name>visible<\/name>/)
    assert.doesNotMatch(guidance, /manual-only/)
  })
})

test("skill loader discovers Cursor and Claude Code skill roots", async () => {
  await withWorkspace(async (cwd, home) => {
    const { loadSkills } = await import("../dist/skills/loader.js")

    await writeSkill(join(cwd, ".furnace", "skills"), "shared-name")
    await writeSkill(join(home, ".cursor", "skills-cursor"), "cursor-local")
    await writeSkill(join(home, ".cursor", "plugins", "cache", "cursor-public", "demo", "release_v1", "skills"), "cursor-plugin")
    await writeSkill(join(home, ".claude", "skills"), "claude-local")
    await writeSkill(join(home, ".claude", "plugins", "cache", "official", "demo", "1.0.0", "skills"), "claude-plugin")
    await writeSkill(join(home, ".claude", "skills"), "shared-name")

    const catalog = await loadSkills(cwd)
    const names = catalog.skills.map((skill) => skill.name)

    assert.deepEqual(
      ["claude-local", "claude-plugin", "cursor-local", "cursor-plugin", "shared-name"].every((name) => names.includes(name)),
      true,
    )
    assert.equal(catalog.skills.find((skill) => skill.name === "shared-name")?.filePath.startsWith(cwd), true)
    assert.equal(catalog.diagnostics.some((diagnostic) => /Duplicate skill name ignored: shared-name/.test(diagnostic.message)), true)
  })
})

test("skill tool loads full skill content", async () => {
  await withWorkspace(async (cwd) => {
    const { executeToolCall } = await import("../dist/tools/registry.js")
    await writeSkill(join(cwd, ".furnace", "skills"), "research")

    const result = await executeToolCall(
      { name: "skill", arguments: JSON.stringify({ name: "research" }) },
      { cwd, sessionId: "session-1" },
    )

    assert.match(result.content, /<skill_content name="research">/)
    assert.match(result.content, /Use this skill carefully/)
    assert.match(result.content, /Base directory for this skill/)
  })
})

test("skill_manage creates a reloadable local skill", async () => {
  await withWorkspace(async (cwd) => {
    const { executeToolCall } = await import("../dist/tools/registry.js")
    const { loadSkillByName } = await import("../dist/skills/loader.js")

    const result = await executeToolCall(
      {
        name: "skill_manage",
        arguments: JSON.stringify({
          name: "terminal-polish",
          description: "Improves terminal interface spacing and copy. Use when polishing terminal UI.",
          body: "# Terminal Polish\n\nKeep panels compact and readable.",
        }),
      },
      { cwd, sessionId: "session-1" },
    )

    assert.match(result.content, /Created skill terminal-polish/)
    const skill = await loadSkillByName(cwd, "terminal-polish")
    assert.equal(skill?.description, "Improves terminal interface spacing and copy. Use when polishing terminal UI.")
    assert.equal(skill?.disableModelInvocation, true)
    assert.match(skill?.content || "", /Keep panels compact/)
  })
})

test("configured extra skill paths are discoverable", async () => {
  await withWorkspace(async (cwd) => {
    const { loadSkills } = await import("../dist/skills/loader.js")
    await writeSkill(join(cwd, "custom-skills"), "configured-skill")

    const catalog = await loadSkills(cwd, { extraPaths: ["custom-skills"] })
    assert.equal(catalog.skills.some((skill) => skill.name === "configured-skill" && skill.provenance === "configured"), true)
  })
})

test("explicit skill invocation message includes optional user instruction", async () => {
  await withWorkspace(async (cwd) => {
    const { renderSkillInvocationMessage } = await import("../dist/skills/context.js")
    const { loadSkillByName } = await import("../dist/skills/loader.js")
    await writeSkill(join(cwd, ".furnace", "skills"), "polish")
    const skill = await loadSkillByName(cwd, "polish")

    const message = renderSkillInvocationMessage(skill, "focus on terminal spacing")
    assert.match(message, /The user has invoked the polish skill/)
    assert.match(message, /focus on terminal spacing/)
  })
})
