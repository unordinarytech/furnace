/**
 * Ported from pi (https://github.com/earendil-works/pi).
 * MIT License, Copyright (c) 2025 Mario Zechner.
 *
 * Render-only port of pi's core/tools/index.ts: only the pieces used by
 * ToolExecutionComponent (tool names and render-capable definitions) are kept.
 */
import type { ToolDefinition } from "./types.js";
import { createAskQuestionToolDefinition } from "./ask-question.js";
import { createBashToolDefinition } from "./bash.js";
import { createEditToolDefinition } from "./edit.js";
import { createFindToolDefinition } from "./find.js";
import { createGrepToolDefinition } from "./grep.js";
import { createLsToolDefinition } from "./ls.js";
import { createReadToolDefinition } from "./read.js";
import { createWriteToolDefinition } from "./write.js";
import { createTodoToolDefinition } from "./todo.js";

export type { ToolDefinition, ToolRenderContext, ToolRenderResultOptions, AgentToolResult } from "./types.js";
export { type BashToolDetails, type BashToolInput, createBashToolDefinition } from "./bash.js";
export { createEditToolDefinition, type EditToolDetails, type EditToolInput } from "./edit.js";
export { createFindToolDefinition, type FindToolDetails, type FindToolInput } from "./find.js";
export { createGrepToolDefinition, type GrepToolDetails, type GrepToolInput } from "./grep.js";
export { createLsToolDefinition, type LsToolDetails, type LsToolInput } from "./ls.js";
export { createReadToolDefinition, type ReadToolDetails, type ReadToolInput } from "./read.js";
export { createWriteToolDefinition, type WriteToolInput } from "./write.js";
export { createAskQuestionToolDefinition } from "./ask-question.js";
export { createTodoToolDefinition } from "./todo.js";

export type ToolDef = ToolDefinition<any, any>;
export type ToolName = "read" | "bash" | "edit" | "write" | "grep" | "find" | "ls" | "ask_question" | "todoread" | "todowrite";
export const allToolNames: Set<ToolName> = new Set(["read", "bash", "edit", "write", "grep", "find", "ls", "ask_question", "todoread", "todowrite"]);

export function createToolDefinition(toolName: ToolName, cwd: string): ToolDef {
	switch (toolName) {
		case "read":
			return createReadToolDefinition(cwd);
		case "bash":
			return createBashToolDefinition(cwd);
		case "edit":
			return createEditToolDefinition(cwd);
		case "write":
			return createWriteToolDefinition(cwd);
		case "grep":
			return createGrepToolDefinition(cwd);
		case "find":
			return createFindToolDefinition(cwd);
		case "ls":
			return createLsToolDefinition(cwd);
		case "ask_question":
			return createAskQuestionToolDefinition();
		case "todoread":
		case "todowrite":
			return createTodoToolDefinition(toolName);
		default:
			throw new Error(`Unknown tool name: ${toolName}`);
	}
}

export function createAllToolDefinitions(cwd: string): Record<ToolName, ToolDef> {
	return {
		read: createReadToolDefinition(cwd),
		bash: createBashToolDefinition(cwd),
		edit: createEditToolDefinition(cwd),
		write: createWriteToolDefinition(cwd),
		grep: createGrepToolDefinition(cwd),
		find: createFindToolDefinition(cwd),
		ls: createLsToolDefinition(cwd),
		ask_question: createAskQuestionToolDefinition(),
		todoread: createTodoToolDefinition("todoread"),
		todowrite: createTodoToolDefinition("todowrite"),
	};
}
