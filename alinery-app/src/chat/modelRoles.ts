/**
 * Model roles a playbook step can name as `role:<name>` in its model. `default` is the Settings default model, shown and not
 * stored; every other role left unassigned uses it too. The daemon resolves them (`roleModel`, `sessionControls.ts`).
 */
export const BUILTIN_MODEL_ROLES = ["default", "tiny", "advisor", "planner", "vision"] as const;

export type BuiltinModelRole = (typeof BUILTIN_MODEL_ROLES)[number];

export type ModelRolesMap = Record<string, string>;
