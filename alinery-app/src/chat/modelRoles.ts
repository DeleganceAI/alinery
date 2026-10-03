/** Built-in OMP model roles (settings `modelRoles`). Values are `provider/id` plus optional `:thinking`. */
export const BUILTIN_MODEL_ROLES = ["default", "smol", "slow", "vision", "plan", "designer", "commit", "tiny", "task", "advisor"] as const;

export type BuiltinModelRole = (typeof BUILTIN_MODEL_ROLES)[number];

export type ModelRolesMap = Record<string, string>;

export const REASONING_EFFORTS = ["off", "minimal", "low", "medium", "high", "xhigh", "max", "auto"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export function splitModelEffort(value: string): { model: string; effort: ReasoningEffort } {
  const colon = value.lastIndexOf(":");
  const suffix = value.slice(colon + 1);
  if (colon >= 0 && REASONING_EFFORTS.includes(suffix as ReasoningEffort)) {
    return { model: value.slice(0, colon), effort: suffix as ReasoningEffort };
  }
  return { model: value, effort: "off" };
}

export function withModelEffort(model: string, effort: ReasoningEffort): string {
  const base = splitModelEffort(model).model;
  return base ? `${base}:${effort}` : "";
}
