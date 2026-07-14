export type AskQuestionOption = {
  description?: string
  id: string
  label: string
}

export type AskQuestionItem = {
  allowCustom: boolean
  allowMultiple: boolean
  allowRefuse?: boolean
  id: string
  options: AskQuestionOption[]
  prompt: string
}

export type AskQuestionRequest = {
  questions: AskQuestionItem[]
}

export type AskQuestionAnswer = {
  answer: string
  kind: "custom" | "option" | "refuse"
  optionId?: string
  questionId: string
}

export type AskQuestionResponse = {
  answers: AskQuestionAnswer[]
  rejected?: boolean
}

export type AskQuestionPrompt = (request: AskQuestionRequest) => Promise<AskQuestionResponse>

export function normalizeAskQuestionRequest(args: unknown): AskQuestionRequest {
  const questionsValue = getRecord(args).questions
  if (!Array.isArray(questionsValue) || questionsValue.length === 0) {
    throw new Error("ask_question requires at least one question")
  }

  return {
    questions: questionsValue.map((item, index) => normalizeQuestion(item, index)),
  }
}

export function formatAskQuestionResult(response: AskQuestionResponse): string {
  if (response.rejected) {
    return "The user dismissed the question request. Continue only if you can proceed safely without those answers."
  }

  const lines = response.answers.map((answer) => {
    const prefix = answer.kind === "refuse" ? "refused" : answer.kind === "custom" ? "wrote" : "selected"
    return `${answer.questionId}: user ${prefix} "${answer.answer}"`
  })
  return `User answered the questions:\n${lines.join("\n")}`
}

function normalizeQuestion(value: unknown, index: number): AskQuestionItem {
  const record = getRecord(value)
  const prompt = stringValue(record.prompt) || stringValue(record.question)
  if (!prompt) throw new Error(`Question ${index + 1} is missing prompt`)

  const rawId = stringValue(record.id)
  const optionsValue = Array.isArray(record.options) ? record.options : []
  const allowCustom = record.allowCustom !== false && record.custom !== false
  const options = optionsValue
    .map((option, optionIndex) => normalizeOption(option, optionIndex))
    .filter((option) => option.label && !isUiProvidedMetaOption(option, allowCustom))

  return {
    allowCustom,
    allowMultiple: record.allowMultiple === true || record.multiple === true,
    allowRefuse: record.allowRefuse !== false && record.refuse !== false,
    id: rawId || `q${index + 1}`,
    options,
    prompt,
  }
}

function isUiProvidedMetaOption(option: AskQuestionOption, allowCustom: boolean): boolean {
  const values = [option.id, option.label, option.description || ""].map((value) => value.toLowerCase().trim()).filter(Boolean)
  return values.some((value) => isRefusalMetaOption(value) || (allowCustom && isCustomMetaOption(value)))
}

function isCustomMetaOption(value: string): boolean {
  const normalized = value.replace(/['’]/g, "").replace(/\s+/g, " ").trim()
  return (
    /^(other|custom|custom answer|something else|let me specify|let me decide|ill specify|i will specify|specify|type my own|write my own|enter my own|provide my own)$/.test(normalized) ||
    /^(let me|ill|i will|user can|user should) (specify|choose|decide|type|write|enter|provide)\b/.test(normalized) ||
    /^(type|write|enter|provide) (my|your|their) own\b/.test(normalized)
  )
}

function isRefusalMetaOption(value: string): boolean {
  const normalized = value.replace(/['’]/g, "").replace(/\s+/g, " ").trim()
  return /^(refuse|refuse to answer|skip|skip this|dismiss|cancel|continue without this answer|dont answer|do not answer)$/.test(normalized)
}

function normalizeOption(value: unknown, index: number): AskQuestionOption {
  if (typeof value === "string") {
    return { id: slugOption(value, index), label: value }
  }
  const record = getRecord(value)
  const label = stringValue(record.label) || stringValue(record.text) || stringValue(record.value) || stringValue(record.description)
  return {
    description: stringValue(record.description),
    id: stringValue(record.id) || stringValue(record.value) || slugOption(label || `option-${index + 1}`, index),
    label,
  }
}

function getRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

function slugOption(value: string, index: number): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return slug || `option-${index + 1}`
}
