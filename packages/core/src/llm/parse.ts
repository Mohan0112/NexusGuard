// packages/core/src/llm/parse.ts
// Extract the last ```json fence from LLM output

export function extractJsonFence(text: string): string | null {
  const pattern = /```json\s*([\s\S]*?)```/g;
  let last: string | null = null;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    last = match[1]?.trim() ?? null;
  }
  return last;
}

export function tryParseJson(text: string): unknown | null {
  const fence = extractJsonFence(text);
  if (!fence) return null;
  try {
    return JSON.parse(fence);
  } catch {
    return null;
  }
}
