/** Built-in OMP model roles (settings `modelRoles`). Values are `provider/id` plus optional `:thinking`. */
export const BUILTIN_MODEL_ROLES = ["default", "smol", "slow", "vision", "plan", "designer", "commit", "tiny", "task", "advisor"] as const;

export type BuiltinModelRole = (typeof BUILTIN_MODEL_ROLES)[number];

export type ModelRolesMap = Record<string, string>;
