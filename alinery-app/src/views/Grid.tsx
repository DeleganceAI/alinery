import { type CSSProperties, type KeyboardEvent, type PointerEvent as ReactPointerEvent, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { type ArchiveTaskPhase, archiveBoardTask } from "../archiveTask";
import * as ipc from "../ipc";
import { PullRequestIndicator } from "../PullRequestIndicator";
import {
  ArchiveTaskModal,
  Checkbox,
  EMPTY_TASK_ACTIVITY,
  InlineStatus,
  repoName,
  sameBoardTasks,
  sameKanbanColumns,
  TaskActivityIndicators,
  taskKey,
  useBoardTaskActivity,
} from "../shared";
import type { BoardNav, BoardTask, KanbanColumn, NormalizedStep, TaskActivityStatus, TaskExecutionReply } from "../types";
import { usePointerDrag } from "../usePointerDrag";
import { useTaskPullRequests } from "../useTaskPullRequests";

type PresetKey = "kanban" | "steps" | "quadrants" | "atlas" | "age" | "progress";
type PresetSelection = PresetKey | "custom";
type PositionModel = "packed" | "lanes";
type ProgressField = "stage" | "column" | "status" | "createdWindow";
type Direction = "ltr" | "rtl";
type MovementMemory = "current" | "previous";
type PathLabels = "all" | "next" | "none";
type DataField = "column" | "stage" | "repo" | "playbook" | "createdWindow" | "status" | "attention";
type GroupField = "none" | DataField;
type Placement = "columns" | "rows" | "quadrants";
type ColumnFlow = "wrap" | "scroll";
type FillField = "none" | "stage" | "repo" | "playbook" | "status" | "attention";
type BorderField = "none" | "accent" | "repo" | "playbook" | "status" | "attention";
type SortField = "manual" | "updatedHours" | "createdAtAsc" | "createdDays" | "importance" | "name" | "sessions" | "stage" | "repo";
type CardMode = "detail" | "compact" | "icon";
type TaskFilter = "all" | "active" | "attention";
type Brightness = "updatedHours" | "none";
type CardProperty = "activity" | "pullRequest" | "name" | "repo" | "playbook" | "stage" | "status" | "sessions" | "updatedHours" | "createdDays" | "attention";

type GridConfig = {
  position: PositionModel;
  progress: ProgressField;
  direction: Direction;
  memory: MovementMemory;
  path: PathLabels;
  group: GroupField;
  placement: Placement;
  columnFlow: ColumnFlow;
  fill: FillField;
  border: BorderField;
  sort: SortField;
  mode: CardMode;
  width: number;
  height: number;
  rowSpacing: number;
  columnSpacing: number;
  label: number;
  tracks: number;
  columnCards: number;
  filter: TaskFilter;
  fade: Brightness;
  properties: CardProperty[];
};

type TaskFacts = {
  task: BoardTask;
  id: string;
  name: string;
  repo: string;
  playbook: string;
  stage: string;
  column: string;
  statusKey: GridActivityState;
  status: string;
  attention: string;
  sessions: number;
  updatedHours: number;
  createdDays: number;
  createdWindow: string;
};

type ProgressCell = { key: string; label: string; summary?: string; active?: boolean };
type ExecutionRef = { key: string; repoPath: string; slug: string };
type MovementHistory = Record<string, Partial<Record<ProgressField, string[]>>>;
type GridActivityState = TaskActivityStatus | "none";
type LaneDragPreview = {
  taskId: string;
  left: number;
  top: number;
  width: number;
  height: number;
  pointerOffsetY: number;
};
type GridWorkspaceState = {
  settingsOpen: boolean;
  preset: PresetSelection;
  config: GridConfig;
  showArchived: boolean;
  selectedTaskKey: string;
  manualOrder: string[];
  hiddenTaskIds: string[];
  hiddenGroupKeys: string[];
};

const STATUS_LABELS: Record<GridActivityState, string> = {
  running: "Running",
  waiting_for_input: "Waiting for input",
  waiting_for_approval: "Waiting for approval",
  failed: "Failed",
  completed: "Complete",
  none: "No session",
};
const STATUS_ORDER: GridActivityState[] = ["none", "waiting_for_input", "waiting_for_approval", "failed", "running", "completed"];
const ATTENTION_ORDER = ["Input", "Approval", "None"];
const AGE_WINDOWS = ["New this week", "8–30 days", "31–90 days", "90+ days"];
const PROGRESS_FIELDS: ProgressField[] = ["stage", "column", "status", "createdWindow"];
const GLYPHS = ["◇", "◆", "◈", "⌘", "↯", "◫", "⌁", "✣", "⬡", "⌥", "⊞", "!", "◒", "×", "⌗", "↳", "▣", "⊗", "∞", "↔"];

const PRESET_OPTIONS = [
  { value: "kanban", label: "Existing Kanban" },
  { value: "steps", label: "Step Kanban" },
  { value: "quadrants", label: "Repository quadrants" },
  { value: "atlas", label: "Icon atlas" },
  { value: "age", label: "Active age windows" },
  { value: "progress", label: "Progress lanes" },
] as const;
const PRESET_SELECT_OPTIONS = [...PRESET_OPTIONS, { value: "custom", label: "Custom", disabled: true }] as const;
const POSITION_OPTIONS = [
  { value: "packed", label: "Packed grid" },
  { value: "lanes", label: "Stable task lanes" },
] as const;
const PROGRESS_OPTIONS = [
  { value: "stage", label: "Playbook step" },
  { value: "column", label: "Kanban phase" },
  { value: "status", label: "Runtime status" },
  { value: "createdWindow", label: "Created age" },
] as const;
const DIRECTION_OPTIONS = [
  { value: "ltr", label: "Left → right" },
  { value: "rtl", label: "Right → left" },
] as const;
const MEMORY_OPTIONS = [
  { value: "current", label: "Current position" },
  { value: "previous", label: "Previous position + trail" },
] as const;
const PATH_OPTIONS = [
  { value: "all", label: "Every playbook step" },
  { value: "next", label: "Next step only" },
  { value: "none", label: "None" },
] as const;
const GROUP_OPTIONS = [
  { value: "none", label: "None" },
  { value: "column", label: "Kanban column" },
  { value: "stage", label: "Latest step" },
  { value: "repo", label: "Repository" },
  { value: "playbook", label: "Playbook" },
  { value: "createdWindow", label: "Created age" },
  { value: "status", label: "Runtime status" },
  { value: "attention", label: "Needs attention" },
] as const;
const PLACEMENT_OPTIONS = [
  { value: "columns", label: "Columns" },
  { value: "rows", label: "Rows" },
  { value: "quadrants", label: "Sections / quadrants" },
] as const;
const COLUMN_FLOW_OPTIONS = [
  { value: "wrap", label: "Wrap to rows" },
  { value: "scroll", label: "Single row + scroll" },
] as const;
const FILL_OPTIONS = [
  { value: "none", label: "None" },
  { value: "stage", label: "Latest step" },
  { value: "repo", label: "Repository" },
  { value: "playbook", label: "Playbook" },
  { value: "status", label: "Runtime status" },
  { value: "attention", label: "Needs attention" },
] as const;
const BORDER_OPTIONS = [
  { value: "none", label: "None" },
  { value: "accent", label: "Accent color" },
  { value: "repo", label: "Repository" },
  { value: "playbook", label: "Playbook" },
  { value: "status", label: "Runtime status" },
  { value: "attention", label: "Needs attention" },
] as const;
const SORT_OPTIONS = [
  { value: "manual", label: "Manual priority" },
  { value: "updatedHours", label: "Recently updated" },
  { value: "createdAtAsc", label: "Created at (asc)" },
  { value: "createdDays", label: "Created at (desc)" },
  { value: "importance", label: "Needs attention" },
  { value: "name", label: "Name" },
  { value: "sessions", label: "Session count" },
  { value: "stage", label: "Playbook step" },
  { value: "repo", label: "Repository" },
] as const;
const MODE_OPTIONS = [
  { value: "detail", label: "Detailed" },
  { value: "compact", label: "Compact" },
  { value: "icon", label: "Icon only" },
] as const;
const FILTER_OPTIONS = [
  { value: "all", label: "All tasks" },
  { value: "active", label: "Active only" },
  { value: "attention", label: "Needs attention" },
] as const;
const BRIGHTNESS_OPTIONS = [
  { value: "updatedHours", label: "Recency" },
  { value: "none", label: "Fixed" },
] as const;
const CARD_PROPERTIES: { value: CardProperty; label: string }[] = [
  { value: "activity", label: "session activity" },
  { value: "name", label: "title" },
  { value: "repo", label: "repo" },
  { value: "playbook", label: "playbook" },
  { value: "stage", label: "step" },
  { value: "status", label: "status" },
  { value: "sessions", label: "sessions" },
  { value: "updatedHours", label: "updated" },
  { value: "createdDays", label: "created" },
  { value: "attention", label: "attention" },
  { value: "pullRequest", label: "pull request" },
];

const PRESETS: Record<PresetKey, GridConfig> = {
  kanban: {
    position: "packed",
    group: "column",
    placement: "columns",
    columnFlow: "wrap",
    fill: "stage",
    border: "repo",
    sort: "updatedHours",
    mode: "detail",
    width: 150,
    height: 112,
    rowSpacing: 10,
    columnSpacing: 10,
    label: 190,
    tracks: 4,
    columnCards: 2,
    filter: "all",
    fade: "updatedHours",
    progress: "stage",
    direction: "ltr",
    memory: "current",
    path: "all",
    properties: ["name", "repo", "playbook", "stage", "sessions"],
  },
  steps: {
    position: "packed",
    group: "stage",
    placement: "columns",
    columnFlow: "wrap",
    fill: "playbook",
    border: "repo",
    sort: "updatedHours",
    mode: "compact",
    width: 96,
    height: 82,
    rowSpacing: 10,
    columnSpacing: 10,
    label: 190,
    tracks: 8,
    columnCards: 2,
    filter: "all",
    fade: "updatedHours",
    progress: "stage",
    direction: "ltr",
    memory: "current",
    path: "all",
    properties: ["name", "repo", "sessions"],
  },
  quadrants: {
    position: "packed",
    group: "repo",
    placement: "quadrants",
    columnFlow: "wrap",
    fill: "playbook",
    border: "status",
    sort: "importance",
    mode: "compact",
    width: 142,
    height: 76,
    rowSpacing: 10,
    columnSpacing: 10,
    label: 190,
    tracks: 2,
    columnCards: 2,
    filter: "all",
    fade: "updatedHours",
    progress: "stage",
    direction: "ltr",
    memory: "current",
    path: "all",
    properties: ["name", "playbook", "stage"],
  },
  atlas: {
    position: "packed",
    group: "playbook",
    placement: "rows",
    columnFlow: "wrap",
    fill: "repo",
    border: "status",
    sort: "stage",
    mode: "icon",
    width: 48,
    height: 48,
    rowSpacing: 10,
    columnSpacing: 10,
    label: 190,
    tracks: 1,
    columnCards: 2,
    filter: "all",
    fade: "updatedHours",
    progress: "stage",
    direction: "ltr",
    memory: "current",
    path: "all",
    properties: [],
  },
  age: {
    position: "packed",
    group: "createdWindow",
    placement: "columns",
    columnFlow: "wrap",
    fill: "repo",
    border: "status",
    sort: "importance",
    mode: "detail",
    width: 150,
    height: 108,
    rowSpacing: 10,
    columnSpacing: 10,
    label: 190,
    tracks: 4,
    columnCards: 2,
    filter: "active",
    fade: "updatedHours",
    progress: "stage",
    direction: "ltr",
    memory: "current",
    path: "all",
    properties: ["name", "repo", "playbook", "stage", "createdDays"],
  },
  progress: {
    position: "lanes",
    group: "none",
    placement: "rows",
    columnFlow: "wrap",
    fill: "repo",
    border: "attention",
    sort: "manual",
    mode: "compact",
    width: 150,
    height: 64,
    rowSpacing: 10,
    columnSpacing: 10,
    label: 190,
    tracks: 1,
    columnCards: 2,
    filter: "active",
    fade: "none",
    progress: "stage",
    direction: "ltr",
    memory: "previous",
    path: "all",
    properties: ["name", "stage", "status"],
  },
};

function defaultGridWorkspace(initialPreset: PresetKey): GridWorkspaceState {
  return {
    settingsOpen: false,
    preset: initialPreset,
    config: { ...PRESETS[initialPreset], properties: [...PRESETS[initialPreset].properties] },
    showArchived: false,
    selectedTaskKey: "",
    manualOrder: [],
    hiddenTaskIds: [],
    hiddenGroupKeys: [],
  };
}

function loadGridWorkspace(storageKey?: string, initialPreset: PresetKey = "kanban"): GridWorkspaceState {
  const fallback = defaultGridWorkspace(initialPreset);
  if (!storageKey) return fallback;
  try {
    const storageName = `alinery:grid:${storageKey}`;
    const currentRaw = window.localStorage.getItem(storageName);
    const saved = JSON.parse(currentRaw ?? "null") as Partial<GridWorkspaceState> | null;
    if (!saved?.config) return fallback;
    const savedConfig = saved.config;
    return {
      settingsOpen: Boolean(saved.settingsOpen),
      preset: saved.preset ?? "custom",
      config: {
        ...fallback.config,
        ...savedConfig,
        rowSpacing: savedConfig.rowSpacing ?? fallback.config.rowSpacing,
        columnSpacing: savedConfig.columnSpacing ?? fallback.config.columnSpacing,
        memory: savedConfig.memory === "current" || savedConfig.memory === "previous" ? savedConfig.memory : fallback.config.memory,
        properties: Array.isArray(savedConfig.properties) ? savedConfig.properties : fallback.config.properties,
      },
      showArchived: Boolean(saved.showArchived),
      selectedTaskKey: saved.selectedTaskKey ?? "",
      manualOrder: Array.isArray(saved.manualOrder) ? saved.manualOrder : [],
      hiddenTaskIds: Array.isArray(saved.hiddenTaskIds) ? saved.hiddenTaskIds : [],
      hiddenGroupKeys: Array.isArray(saved.hiddenGroupKeys) ? saved.hiddenGroupKeys : [],
    };
  } catch {
    return fallback;
  }
}

type RandomSource = () => number;

function randomOption<Value extends string>(options: readonly { value: Value }[], random: RandomSource): Value {
  const option = options[Math.min(options.length - 1, Math.floor(random() * options.length))];
  if (!option) throw new Error("Cannot randomize an empty option list");
  return option.value;
}

function randomStep(min: number, max: number, step: number, random: RandomSource) {
  const count = Math.floor((max - min) / step) + 1;
  return min + Math.min(count - 1, Math.floor(random() * count)) * step;
}

function randomGridConfig(random: RandomSource): GridConfig {
  const properties = CARD_PROPERTIES.filter(() => random() >= 0.5).map((property) => property.value);
  if (properties.length === 0) {
    const fallback = CARD_PROPERTIES[Math.min(CARD_PROPERTIES.length - 1, Math.floor(random() * CARD_PROPERTIES.length))];
    properties.push(fallback?.value ?? "name");
  }

  return {
    position: randomOption(POSITION_OPTIONS, random),
    progress: randomOption(PROGRESS_OPTIONS, random),
    direction: randomOption(DIRECTION_OPTIONS, random),
    memory: randomOption(MEMORY_OPTIONS, random),
    path: randomOption(PATH_OPTIONS, random),
    group: randomOption(GROUP_OPTIONS, random),
    placement: randomOption(PLACEMENT_OPTIONS, random),
    columnFlow: randomOption(COLUMN_FLOW_OPTIONS, random),
    fill: randomOption(FILL_OPTIONS, random),
    border: randomOption(BORDER_OPTIONS, random),
    sort: randomOption(SORT_OPTIONS, random),
    mode: randomOption(MODE_OPTIONS, random),
    width: randomStep(42, 240, 6, random),
    height: randomStep(42, 170, 2, random),
    label: randomStep(140, 420, 10, random),
    rowSpacing: randomStep(0, 24, 1, random),
    columnSpacing: randomStep(0, 24, 1, random),
    tracks: randomStep(1, 8, 1, random),
    columnCards: randomStep(1, 6, 1, random),
    filter: randomOption(FILTER_OPTIONS, random),
    fade: randomOption(BRIGHTNESS_OPTIONS, random),
    properties,
  };
}

function ageIn(epochSeconds: number, unitSeconds: number) {
  if (!epochSeconds) return 0;
  return Math.max(0, Math.floor((Date.now() / 1000 - epochSeconds) / unitSeconds));
}

function ageWindow(days: number) {
  if (days <= 7) return AGE_WINDOWS[0];
  if (days <= 30) return AGE_WINDOWS[1];
  if (days <= 90) return AGE_WINDOWS[2];
  return AGE_WINDOWS[3];
}

function attentionFor(status: GridActivityState) {
  if (status === "waiting_for_input") return "Input";
  if (status === "waiting_for_approval") return "Approval";
  return "None";
}

function factValue(fact: TaskFacts, field: DataField) {
  switch (field) {
    case "column":
      return fact.column;
    case "stage":
      return fact.stage;
    case "repo":
      return fact.repo;
    case "playbook":
      return fact.playbook;
    case "createdWindow":
      return fact.createdWindow;
    case "status":
      return fact.status;
    case "attention":
      return fact.attention;
  }
}

function optionLabel(options: readonly { value: string; label: string }[], value: string) {
  return options.find((option) => option.value === value)?.label ?? value;
}

function stableTone(field: string, value: string, kind: "fill" | "border", values: string[]) {
  if (field === "none") return "transparent";
  if (field === "accent") return "var(--accent)";
  const mappedIndex = values.indexOf(value);
  if (mappedIndex >= 0) return `var(--task-grid-${kind}-${mappedIndex % 8})`;
  const hash = [...`${field}:${value}`].reduce((sum, char) => sum + char.charCodeAt(0), 0);
  return `var(--task-grid-${kind}-${hash % 8})`;
}

function borderTone(field: BorderField, fact: TaskFacts, values: string[], none: string) {
  if (field === "none") return none;
  return stableTone(field, field === "accent" ? "Accent" : factValue(fact, field), "border", values);
}

function stagePath(fact: TaskFacts, executions: Record<string, TaskExecutionReply>): ProgressCell[] {
  const execution = executions[fact.id];
  const states = new Map<string, Map<string, number>>();
  if (execution) {
    for (const record of Object.values(execution.state.executions)) {
      const key = record.candidate.step_key;
      let counts = states.get(key);
      if (!counts) {
        counts = new Map();
        states.set(key, counts);
      }
      counts.set(record.lifecycle, (counts.get(record.lifecycle) ?? 0) + 1);
    }
  }
  const steps: NormalizedStep[] = execution?.definition.step ?? [];
  const path: ProgressCell[] = steps.map((step) => {
    const counts = states.get(step.key);
    return {
      key: step.key,
      label: step.short || step.title || step.key,
      active: Boolean(counts?.has("starting") || counts?.has("running") || counts?.has("finishing")),
      summary: counts
        ? [...counts]
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([state, count]) => `${count} ${state.replace(/_/g, " ")}`)
            .join(", ")
        : execution?.state.enabled_steps.includes(step.key)
          ? "Not started"
          : "Not started · Human completion required",
    };
  });
  const current = fact.task.current_phase || "";
  if (!path.some((step) => step.key === current)) {
    const summary = fact.task.draft ? "Draft" : (fact.task.engine_version ?? 0) < 2 ? "Legacy task" : execution ? undefined : "Execution unavailable";
    path.push({ key: current, label: fact.stage, summary });
  }
  return path.sort((left, right) => left.label.localeCompare(right.label) || left.key.localeCompare(right.key));
}

function currentProgressKey(fact: TaskFacts, field: ProgressField) {
  switch (field) {
    case "stage":
      return fact.task.current_phase || "";
    case "column":
      return fact.task.current_column_key || fact.column;
    case "status":
      return fact.statusKey;
    case "createdWindow":
      return fact.createdWindow;
  }
}

function progressPath(fact: TaskFacts, field: ProgressField, columns: KanbanColumn[], executions: Record<string, TaskExecutionReply>): ProgressCell[] {
  if (field === "stage") return stagePath(fact, executions);
  if (field === "status") return STATUS_ORDER.map((key) => ({ key, label: STATUS_LABELS[key] }));
  if (field === "createdWindow") return AGE_WINDOWS.map((value) => ({ key: value, label: value }));
  const path = columns.map((column) => ({ key: column.key, label: column.title || column.key }));
  const current = fact.task.current_column_key || fact.column;
  if (!path.some((column) => column.key === current)) path.push({ key: current, label: fact.column });
  return path.length ? path : [{ key: current, label: fact.column }];
}

function orderedFieldValues(field: DataField, facts: TaskFacts[], columns: KanbanColumn[]) {
  const found = [...new Set(facts.map((fact) => factValue(fact, field)))];
  let requested: string[] = [];
  if (field === "column") requested = columns.map((column) => column.title || column.key);
  if (field === "createdWindow") requested = AGE_WINDOWS;
  if (field === "status") requested = STATUS_ORDER.map((status) => STATUS_LABELS[status]);
  if (field === "attention") requested = ATTENTION_ORDER;
  return [...requested.filter((value) => found.includes(value)), ...found.filter((value) => !requested.includes(value)).sort((a, b) => a.localeCompare(b))];
}

function attentionRank(fact: TaskFacts) {
  if (fact.attention === "Input") return 3;
  if (fact.attention === "Approval") return 2;
  if (fact.statusKey === "running") return 1;
  return 0;
}

function sortFacts(items: TaskFacts[], sort: SortField, manualOrder: string[], stageOrder: string[]) {
  return [...items].sort((left, right) => {
    let result = 0;
    if (sort === "manual") result = manualOrder.indexOf(left.id) - manualOrder.indexOf(right.id);
    if (sort === "updatedHours") result = left.updatedHours - right.updatedHours;
    if (sort === "createdAtAsc") result = left.task.created - right.task.created;
    if (sort === "createdDays") result = right.task.created - left.task.created;
    if (sort === "importance") result = attentionRank(right) - attentionRank(left) || left.updatedHours - right.updatedHours;
    if (sort === "name") result = left.name.localeCompare(right.name);
    if (sort === "sessions") result = right.sessions - left.sessions;
    if (sort === "stage") result = stageOrder.indexOf(left.stage) - stageOrder.indexOf(right.stage) || left.updatedHours - right.updatedHours;
    if (sort === "repo") result = left.repo.localeCompare(right.repo);
    return result || left.name.localeCompare(right.name);
  });
}

export function reorderGridTasks(order: string[], participating: Set<string>, taskId: string, targetId: string, after: boolean) {
  if (taskId === targetId || !participating.has(taskId) || !participating.has(targetId)) return order;
  const movable = order.filter((id) => participating.has(id) && id !== taskId);
  const targetIndex = movable.indexOf(targetId);
  if (targetIndex < 0) return order;
  movable.splice(targetIndex + (after ? 1 : 0), 0, taskId);
  let nextIndex = 0;
  const next = order.map((id) => (participating.has(id) ? movable[nextIndex++] : id));
  return next.every((id, index) => id === order[index]) ? order : next;
}

function propertyValue(fact: TaskFacts, property: Exclude<CardProperty, "activity" | "pullRequest" | "name">) {
  switch (property) {
    case "repo":
      return fact.repo;
    case "playbook":
      return fact.playbook;
    case "stage":
      return fact.stage;
    case "status":
      return fact.status;
    case "sessions":
      return `${fact.sessions} sess`;
    case "updatedHours":
      return fact.updatedHours === 0 ? "updated now" : `updated ${fact.updatedHours}h`;
    case "createdDays":
      return fact.createdDays === 0 ? "created today" : `created ${fact.createdDays}d`;
    case "attention":
      return fact.attention === "None" ? "no attention" : `needs ${fact.attention.toLowerCase()}`;
  }
}

function SelectField({
  label,
  value,
  options,
  onChange,
  className,
}: {
  label: string;
  value: string;
  options: readonly { value: string; label: string; disabled?: boolean }[];
  onChange: (value: string) => void;
  className?: string;
}) {
  return (
    <label className={`task-grid-field${className ? ` ${className}` : ""}`}>
      <span>{label}</span>
      <select value={value} onChange={(event) => onChange(event.currentTarget.value)}>
        {options.map((option) => (
          <option key={option.value} value={option.value} disabled={option.disabled}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function RangeField({
  label,
  value,
  min,
  max,
  step,
  onChange,
  className,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
  className?: string;
}) {
  return (
    <label className={`task-grid-field${className ? ` ${className}` : ""}`}>
      <span>
        {label} <b>{value}px</b>
      </span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(event) => onChange(Number(event.currentTarget.value))} />
    </label>
  );
}

function GearIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.09a2 2 0 0 1 1 1.74v.5a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.38a2 2 0 0 0-.73-2.73l-.15-.09a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function VisibilityIcon({ hidden }: { hidden: boolean }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" />
      <circle cx="12" cy="12" r="3" />
      {hidden && <path d="m3 3 18 18" />}
    </svg>
  );
}

export function Grid({
  active = true,
  allRepos,
  onOpen,
  onDuplicate = () => {},
  registerNav,
  storageKey,
  initialPreset = "kanban",
}: {
  active?: boolean;
  allRepos: boolean;
  onOpen: (task: BoardTask) => void;
  onDuplicate?: (task: BoardTask) => void;
  registerNav: (nav: BoardNav | null) => void;
  storageKey?: string;
  initialPreset?: PresetKey;
}) {
  const settingsId = useId();
  const initialWorkspace = useMemo(() => loadGridWorkspace(storageKey, initialPreset), [storageKey, initialPreset]);
  const [tasks, setTasks] = useState<BoardTask[]>([]);
  const [columns, setColumns] = useState<KanbanColumn[]>([]);
  const [executions, setExecutions] = useState<Record<string, TaskExecutionReply>>({});
  const [loaded, setLoaded] = useState(false);
  const [err, setErr] = useState("");
  const [executionErrors, setExecutionErrors] = useState<{ ref: ExecutionRef; error: string }[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(initialWorkspace.settingsOpen);
  const [preset, setPreset] = useState<PresetSelection>(initialWorkspace.preset);
  const [config, setConfig] = useState<GridConfig>(initialWorkspace.config);
  const [showArchived, setShowArchived] = useState(initialWorkspace.showArchived);
  const [selectedTaskKey, setSelectedTaskKey] = useState(initialWorkspace.selectedTaskKey);
  const [manualOrder, setManualOrder] = useState<string[]>(initialWorkspace.manualOrder);
  const [hiddenTaskIds, setHiddenTaskIds] = useState<Set<string>>(() => new Set(initialWorkspace.hiddenTaskIds));
  const [hiddenGroupKeys, setHiddenGroupKeys] = useState<Set<string>>(() => new Set(initialWorkspace.hiddenGroupKeys));
  const [dropTarget, setDropTarget] = useState("");
  const [dragPreview, setDragPreview] = useState<LaneDragPreview | null>(null);
  const [pendingArchive, setPendingArchive] = useState<BoardTask | null>(null);
  const draggedTaskId = useRef<string | null>(null);
  const movementHistory = useRef<MovementHistory>({});
  const pointerDrag = usePointerDrag();
  const activity = useBoardTaskActivity(tasks, active);

  useEffect(() => {
    if (!storageKey) return;
    const workspace: GridWorkspaceState = {
      settingsOpen,
      preset,
      config,
      showArchived,
      selectedTaskKey,
      manualOrder,
      hiddenTaskIds: [...hiddenTaskIds],
      hiddenGroupKeys: [...hiddenGroupKeys],
    };
    try {
      window.localStorage.setItem(`alinery:grid:${storageKey}`, JSON.stringify(workspace));
    } catch {
      // A storage failure should never make the Grid unusable.
    }
  }, [storageKey, settingsOpen, preset, config, showArchived, selectedTaskKey, manualOrder, hiddenTaskIds, hiddenGroupKeys]);

  const load = useCallback(async () => {
    try {
      const [nextColumns, nextTasks] = await Promise.all([ipc.listKanbanColumns(allRepos), ipc.listBoardTasks(allRepos)]);
      setColumns((current) => (sameKanbanColumns(current, nextColumns) ? current : nextColumns));
      setTasks((current) => (sameBoardTasks(current, nextTasks) ? current : nextTasks));
      setErr("");
    } catch (error) {
      setErr(String(error));
    } finally {
      setLoaded(true);
    }
  }, [allRepos]);

  useEffect(() => {
    if (!active) return;
    void load();
    const timer = window.setInterval(load, 3000);
    return () => window.clearInterval(timer);
  }, [active, load]);

  const executionRefs = useMemo(() => {
    const refs = new Map<string, ExecutionRef>();
    for (const task of tasks) {
      if (task.draft || (task.engine_version ?? 0) < 2 || (!showArchived && task.archived)) continue;
      const key = taskKey(task);
      refs.set(key, { key, repoPath: task.repo_path, slug: task.slug });
    }
    return [...refs.values()].sort((left, right) => left.key.localeCompare(right.key));
  }, [tasks, showArchived]);

  useEffect(() => {
    if (!active) return;
    let alive = true;
    let loading = false;
    const loadExecutions = async () => {
      if (loading) return;
      loading = true;
      const entries = await Promise.all(
        executionRefs.map(async (ref) => {
          try {
            return { ref, execution: await ipc.getTaskExecution(ref.slug, ref.repoPath), error: "" };
          } catch (error) {
            return { ref, execution: null, error: String(error) };
          }
        }),
      );
      loading = false;
      if (!alive) return;
      setExecutions(Object.fromEntries(entries.flatMap(({ ref, execution }) => (execution ? [[ref.key, execution]] : []))));
      setExecutionErrors(entries.filter((entry) => entry.execution === null));
    };
    void loadExecutions();
    const timer = window.setInterval(loadExecutions, 3000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [active, executionRefs]);

  const facts = useMemo(() => {
    return tasks
      .filter((task) => showArchived || !task.archived)
      .map((task): TaskFacts => {
        const id = taskKey(task);
        const statusKey = activity[id]?.status ?? "none";
        const createdDays = ageIn(task.created, 86400);
        return {
          task,
          id,
          name: task.name,
          repo: repoName(task.repo_path),
          playbook: task.playbook_title || task.playbook,
          stage: task.current_step_title || "Not started",
          column: task.current_column_title || task.current_column_key || "Other",
          statusKey,
          status: STATUS_LABELS[statusKey],
          attention: attentionFor(statusKey),
          sessions: task.session_count,
          updatedHours: ageIn(task.updated || task.created, 3600),
          createdDays,
          createdWindow: ageWindow(createdDays),
        };
      });
  }, [tasks, activity, showArchived]);

  useEffect(() => {
    if (!loaded) return;
    const ids = new Set(facts.map((fact) => fact.id));
    setManualOrder((current) => {
      const next = current.filter((id) => ids.has(id));
      for (const fact of facts) if (!next.includes(fact.id)) next.push(fact.id);
      return next.length === current.length && next.every((id, index) => id === current[index]) ? current : next;
    });
  }, [facts, loaded]);

  const movementSnapshots = useMemo(
    () =>
      facts.map((fact) => ({
        id: fact.id,
        values: {
          stage: currentProgressKey(fact, "stage"),
          column: currentProgressKey(fact, "column"),
          status: currentProgressKey(fact, "status"),
          createdWindow: currentProgressKey(fact, "createdWindow"),
        },
      })),
    [facts],
  );

  useEffect(() => {
    for (const snapshot of movementSnapshots) {
      let taskHistory = movementHistory.current[snapshot.id];
      if (!taskHistory) {
        taskHistory = {};
        movementHistory.current[snapshot.id] = taskHistory;
      }
      for (const field of PROGRESS_FIELDS) {
        const value = snapshot.values[field];
        let history = taskHistory[field];
        if (!history) {
          history = [];
          taskHistory[field] = history;
        }
        if (history[history.length - 1] !== value) {
          history.push(value);
          if (history.length > 2) history.shift();
        }
      }
    }
  }, [movementSnapshots]);

  const visibleFacts = useMemo(() => {
    if (config.filter === "active") return facts.filter((fact) => fact.statusKey !== "completed");
    if (config.filter === "attention") return facts.filter((fact) => fact.attention !== "None");
    return facts;
  }, [facts, config.filter]);

  const stageOrder = useMemo(() => orderedFieldValues("stage", facts, columns), [facts, columns]);
  const groups = useMemo(() => {
    if (config.group === "none") {
      return [{ key: "all", label: "All tasks", tasks: sortFacts(visibleFacts, config.sort, manualOrder, stageOrder) }];
    }
    const values = orderedFieldValues(config.group, visibleFacts, columns);
    return values.map((value) => ({
      key: value,
      label: value,
      tasks: sortFacts(
        visibleFacts.filter((fact) => factValue(fact, config.group as DataField) === value),
        config.sort,
        manualOrder,
        stageOrder,
      ),
    }));
  }, [config.group, config.sort, visibleFacts, columns, manualOrder, stageOrder]);
  const collapsibleGroups = config.position === "packed" && config.placement === "columns";
  const displayFacts = useMemo(
    () => groups.filter((group) => !collapsibleGroups || !hiddenGroupKeys.has(`${config.group}:${group.key}`)).flatMap((group) => group.tasks),
    [groups, hiddenGroupKeys, config.group, collapsibleGroups],
  );
  const showPullRequest = config.properties.includes("pullRequest");
  const pullRequests = useTaskPullRequests(
    active && showPullRequest
      ? displayFacts
          .filter((fact) => !fact.task.draft && (config.position !== "lanes" || !hiddenTaskIds.has(fact.id)))
          .map((fact) => ({ repoPath: fact.task.repo_path, taskSlug: fact.task.slug }))
      : [],
  );

  useEffect(() => {
    if (!loaded) return;
    setSelectedTaskKey((current) => (current && displayFacts.some((fact) => fact.id === current) ? current : (displayFacts[0]?.id ?? "")));
  }, [displayFacts, loaded]);

  useEffect(() => {
    if (!active) return;
    const move = (delta: number) => {
      setSelectedTaskKey((current) => {
        if (!displayFacts.length) return "";
        const index = Math.max(
          0,
          displayFacts.findIndex((fact) => fact.id === current),
        );
        return displayFacts[Math.max(0, Math.min(displayFacts.length - 1, index + delta))].id;
      });
    };
    const selected = displayFacts.find((fact) => fact.id === selectedTaskKey);
    registerNav({
      moveRow: move,
      moveCol: move,
      openSelected: () => {
        if (selected) onOpen(selected.task);
      },
      duplicateSelected: () => {
        if (selected) onDuplicate(selected.task);
      },
      archiveSelected: () => {
        if (selected && !selected.task.archived) setPendingArchive(selected.task);
      },
    });
    return () => registerNav(null);
  }, [active, displayFacts, selectedTaskKey, onOpen, onDuplicate, registerNav]);

  const setField = <Key extends keyof GridConfig>(key: Key, value: GridConfig[Key]) => {
    setPreset("custom");
    setConfig((current) => ({ ...current, [key]: value }));
  };
  const applyPreset = (key: PresetKey) => {
    setPreset(key);
    setConfig({ ...PRESETS[key], properties: [...PRESETS[key].properties] });
  };
  const randomizeSettings = () => {
    setPreset("custom");
    setConfig(randomGridConfig(Math.random));
  };
  const toggleProperty = (property: CardProperty) => {
    setPreset("custom");
    setConfig((current) => ({
      ...current,
      properties: current.properties.includes(property) ? current.properties.filter((value) => value !== property) : [...current.properties, property],
    }));
  };
  const toggleGroup = (key: string) => {
    setHiddenGroupKeys((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };
  const toggleHidden = (id: string) => {
    setHiddenTaskIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const hideAll = () => {
    setHiddenTaskIds((current) => new Set([...current, ...visibleFacts.map((fact) => fact.id)]));
  };
  const unhideAll = () => setHiddenTaskIds(new Set());
  const movableIds = useMemo(() => new Set(visibleFacts.filter((fact) => !hiddenTaskIds.has(fact.id)).map((fact) => fact.id)), [visibleFacts, hiddenTaskIds]);
  const moveManualTask = (taskId: string, targetId: string, after: boolean) => {
    setManualOrder((current) => reorderGridTasks(current, movableIds, taskId, targetId, after));
  };
  const laneAtPoint = (clientX: number, clientY: number) => document.elementFromPoint(clientX, clientY)?.closest<HTMLElement>(".task-grid-lane-row") ?? null;
  const startLaneDrag = (event: ReactPointerEvent<HTMLButtonElement>, taskId: string) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const row = event.currentTarget.closest<HTMLElement>(".task-grid-lane-row");
    const bounds = row?.getBoundingClientRect();
    const left = Math.max(8, bounds?.left ?? 8);
    const height = bounds?.height || 68;
    draggedTaskId.current = taskId;
    setDropTarget(taskId);
    setDragPreview({
      taskId,
      left,
      top: Math.max(8, bounds?.top ?? event.clientY - height / 2),
      width: Math.max(180, Math.min(bounds?.width || 560, window.innerWidth - left - 8)),
      height,
      pointerOffsetY: bounds ? event.clientY - bounds.top : height / 2,
    });
    pointerDrag.start(event, {
      onMove: (moveEvent) => {
        const targetId = laneAtPoint(moveEvent.clientX, moveEvent.clientY)?.dataset.taskId;
        setDropTarget(targetId && movableIds.has(targetId) ? targetId : "");
        setDragPreview((current) =>
          current
            ? {
                ...current,
                top: Math.max(8, Math.min(window.innerHeight - current.height - 8, moveEvent.clientY - current.pointerOffsetY)),
              }
            : null,
        );
      },
      onComplete: (completeEvent) => {
        const source = draggedTaskId.current;
        const target = completeEvent.type === "pointercancel" ? null : laneAtPoint(completeEvent.clientX, completeEvent.clientY);
        const targetId = target?.dataset.taskId;
        if (source && target && targetId && movableIds.has(targetId)) {
          const bounds = target.getBoundingClientRect();
          moveManualTask(source, targetId, completeEvent.clientY > bounds.top + bounds.height / 2);
        }
        draggedTaskId.current = null;
        setDropTarget("");
        setDragPreview(null);
      },
    });
  };

  const selected = facts.find((fact) => fact.id === selectedTaskKey);
  const selectedHidden = selected ? hiddenTaskIds.has(selected.id) : false;
  const groupTracks = config.placement === "rows" ? 1 : config.placement === "quadrants" ? 2 : config.tracks;
  const groupContentWidth = config.columnCards * config.width + Math.max(0, config.columnCards - 1) * config.columnSpacing;
  const groupOuterWidth = groupContentWidth + 18;
  const groupsWrapWidth = groupTracks * groupOuterWidth + Math.max(0, groupTracks - 1) * config.columnSpacing;
  const planText =
    config.position === "lanes"
      ? `fixed task lanes · ${config.progress === "stage" ? "retained step membership · actual execution counts · alphabetical layout, not execution order" : `position by ${optionLabel(PROGRESS_OPTIONS, config.progress).toLowerCase()}`}`
      : `outer grid: ${groupTracks} group track${groupTracks === 1 ? "" : "s"} · ${config.columnCards} card${config.columnCards === 1 ? "" : "s"} per column · ${config.columnFlow === "scroll" ? "single scrolling row" : "wrapped rows"} · ${config.width} × ${config.height}px task cells`;
  const fillLegendValues = config.fill === "none" ? [] : orderedFieldValues(config.fill, visibleFacts, columns);
  const borderLegendValues = config.border === "none" ? [] : config.border === "accent" ? ["Accent"] : orderedFieldValues(config.border, visibleFacts, columns);
  const fillToneValues = config.fill === "none" ? [] : orderedFieldValues(config.fill, facts, columns);
  const borderToneValues = config.border === "none" ? [] : config.border === "accent" ? ["Accent"] : orderedFieldValues(config.border, facts, columns);

  const renderCard = (fact: TaskFacts, placement?: { column: number }) => {
    const fillValue = config.fill === "none" ? "" : factValue(fact, config.fill);
    const opacity = config.fade === "updatedHours" ? Math.max(0.55, 1 - fact.updatedHours / 350) : 1;
    const style = {
      "--task-grid-fill": stableTone(config.fill, fillValue, "fill", fillToneValues),
      "--task-grid-border": borderTone(config.border, fact, borderToneValues, "transparent"),
      "--task-grid-opacity": opacity,
      gridColumn: placement ? String(placement.column + 1) : undefined,
      gridRow: placement && config.progress === "stage" ? "2" : undefined,
    } as CSSProperties;
    const label = `${fact.name}, ${fact.repo}, ${fact.playbook}, ${fact.stage}, ${fact.status}`;
    return (
      <div
        key={`${fact.id}:${placement?.column ?? "packed"}`}
        role="button"
        tabIndex={0}
        className={`task-grid-card task-grid-card-${config.mode}${selectedTaskKey === fact.id ? " selected" : ""}`}
        style={style}
        aria-label={label}
        aria-current={selectedTaskKey === fact.id ? "true" : undefined}
        data-task-id={fact.id}
        onFocus={() => setSelectedTaskKey(fact.id)}
        onMouseDown={() => setSelectedTaskKey(fact.id)}
        onClick={() => onOpen(fact.task)}
        onKeyDown={(event) => {
          if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) {
            event.preventDefault();
            if (!event.repeat) onOpen(fact.task);
          }
        }}
      >
        {(config.properties.includes("activity") || showPullRequest) && (
          <span className="task-grid-card-indicators">
            {config.properties.includes("activity") && <TaskActivityIndicators activity={activity[fact.id] ?? EMPTY_TASK_ACTIVITY} />}
            {showPullRequest && <PullRequestIndicator snapshot={pullRequests[fact.id]} compact />}
          </span>
        )}
        <span className="task-grid-icon" aria-hidden="true">
          {GLYPHS[[...fact.id].reduce((sum, char) => sum + char.charCodeAt(0), 0) % GLYPHS.length]}
        </span>
        {config.properties.includes("name") && <span className="task-grid-card-name">{fact.name}</span>}
        <span className="task-grid-card-meta">
          {config.properties
            .filter(
              (property): property is Exclude<CardProperty, "activity" | "pullRequest" | "name"> => property !== "activity" && property !== "pullRequest" && property !== "name",
            )
            .map((property) => (
              <span key={property}>{propertyValue(fact, property)}</span>
            ))}
        </span>
      </div>
    );
  };

  const renderLane = (fact: TaskFacts) => {
    const semanticCells = progressPath(fact, config.progress, columns, executions);
    const currentKey = currentProgressKey(fact, config.progress);
    const currentSemanticIndex = Math.max(
      0,
      semanticCells.findIndex((cell) => cell.key === currentKey),
    );
    const visualCells = config.direction === "rtl" ? [...semanticCells].reverse() : semanticCells;
    const currentVisualIndex = Math.max(
      0,
      visualCells.findIndex((cell) => cell.key === currentKey),
    );
    const history = movementHistory.current[fact.id]?.[config.progress] ?? [];
    const latest = history[history.length - 1];
    const prior = latest === currentKey ? history[history.length - 2] : latest;
    const previousKey = prior && semanticCells.some((cell) => cell.key === prior) ? prior : undefined;
    const previousVisualIndex = previousKey ? visualCells.findIndex((cell) => cell.key === previousKey) : -1;
    const previousSemanticIndex = previousKey ? semanticCells.findIndex((cell) => cell.key === previousKey) : -1;
    const hasMovement = previousVisualIndex >= 0 && previousVisualIndex !== currentVisualIndex;
    const hidden = hiddenTaskIds.has(fact.id);
    const canReorder = config.sort === "manual" && !hidden;
    const rowStyle = {
      "--task-grid-lane-label": `${config.label}px`,
      "--task-grid-progress-count": semanticCells.length,
      "--task-grid-tile-h": `${config.height}px`,
    } as CSSProperties;
    const laneColor = hidden ? "var(--border)" : borderTone(config.border, fact, borderToneValues, "transparent");
    const participatingOrder = manualOrder.filter((id) => movableIds.has(id));

    const reorderWithKeyboard = (event: KeyboardEvent<HTMLButtonElement>) => {
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
      event.preventDefault();
      const index = participatingOrder.indexOf(fact.id);
      const target = participatingOrder[index + (event.key === "ArrowUp" ? -1 : 1)];
      if (target) moveManualTask(fact.id, target, event.key === "ArrowDown");
    };
    return (
      <li
        key={fact.id}
        className={`task-grid-lane-row${hidden ? " hidden" : ""}${dropTarget === fact.id ? " drop-target" : ""}${dragPreview?.taskId === fact.id ? " dragging" : ""}`}
        style={rowStyle}
        data-task-id={fact.id}
        data-hidden={hidden ? "true" : "false"}
      >
        <div className="task-grid-lane-label" style={{ "--task-grid-lane-color": laneColor } as CSSProperties}>
          <div className="task-grid-lane-name-row">
            {canReorder && (
              <button
                type="button"
                className="task-grid-drag"
                aria-label={`Reorder ${fact.name}; use arrow keys`}
                title="Drag or use arrow keys to change priority"
                onKeyDown={reorderWithKeyboard}
                onPointerDown={(event) => startLaneDrag(event, fact.id)}
              >
                ⋮⋮
              </button>
            )}
            <span className="task-grid-lane-name">{fact.name}</span>
            <button
              type="button"
              className="task-grid-hide"
              aria-label={`${hidden ? "Unhide" : "Hide"} ${fact.name}`}
              title={hidden ? "Unhide task" : "Hide task"}
              onClick={() => toggleHidden(fact.id)}
            >
              <VisibilityIcon hidden={hidden} />
            </button>
          </div>
          {!hidden && <small>{`${fact.repo} · ${fact.playbook}`}</small>}
        </div>
        <fieldset className="task-grid-lane-track" aria-label={`${fact.name} ${config.progress === "stage" ? "retained steps" : "positions"}`}>
          {!hidden && (
            <>
              {visualCells.map((cell, visualIndex) => {
                const semanticIndex = semanticCells.findIndex((candidate) => candidate.key === cell.key);
                const showLabel =
                  config.progress === "stage"
                    ? config.path === "all" || (config.path === "next" && cell.active)
                    : semanticIndex !== currentSemanticIndex && (config.path === "all" || (config.path === "next" && semanticIndex === currentSemanticIndex + 1));
                if (!showLabel) return null;
                return (
                  <span
                    key={cell.key}
                    className="task-grid-lane-step"
                    style={{ gridColumn: visualIndex + 1, gridRow: config.progress === "stage" ? "1" : undefined, opacity: config.progress === "stage" ? 1 : undefined }}
                  >
                    {cell.label}
                    {cell.summary ? ` · ${cell.summary}` : ""}
                  </span>
                );
              })}
              {config.progress !== "stage" && config.memory !== "current" && hasMovement && (
                <>
                  <span
                    role="img"
                    className="task-grid-lane-ghost"
                    style={{ gridColumn: previousVisualIndex + 1 }}
                    aria-label={`Previous position: ${visualCells[previousVisualIndex]?.label ?? previousKey}`}
                  />
                  <span
                    role="img"
                    className={`task-grid-move-line${currentSemanticIndex >= previousSemanticIndex ? "" : " backward"}`}
                    style={{ gridColumn: `${Math.min(previousVisualIndex, currentVisualIndex) + 1} / ${Math.max(previousVisualIndex, currentVisualIndex) + 2}` }}
                    aria-label={currentSemanticIndex >= previousSemanticIndex ? "Moved forward" : "Moved backward"}
                  >
                    <span>{previousVisualIndex < currentVisualIndex ? "→" : "←"}</span>
                  </span>
                </>
              )}
              {renderCard(fact, { column: currentVisualIndex })}
            </>
          )}
        </fieldset>
      </li>
    );
  };

  const confirmArchive = async (removeWorktree: boolean, onPhase: (phase: ArchiveTaskPhase) => void) => {
    const task = pendingArchive;
    if (!task) return;
    const failure = await archiveBoardTask(task, removeWorktree, onPhase);
    setPendingArchive(null);
    if (failure) {
      setErr(`${failure.msg} ${failure.detail}`);
      return;
    }
    void load();
  };

  return (
    <section
      className={`task-grid-view settings-${settingsOpen ? "open" : "collapsed"}`}
      style={
        {
          "--task-grid-tile-w": `${config.width}px`,
          "--task-grid-tile-h": `${config.height}px`,
          "--task-grid-group-cols": groupTracks,
          "--task-grid-column-cards": config.columnCards,
          "--task-grid-group-width": `${groupOuterWidth}px`,
          "--task-grid-groups-wrap-width": `${groupsWrapWidth}px`,
          "--task-grid-row-gap": `${config.rowSpacing}px`,
          "--task-grid-column-gap": `${config.columnSpacing}px`,
        } as CSSProperties
      }
      aria-label="Task grid"
    >
      {settingsOpen ? (
        <div className="task-grid-toolbar">
          <div>
            <strong>GRID</strong>
            <span>{visibleFacts.length} TASKS</span>
          </div>
          <button
            type="button"
            className="task-grid-settings-toggle"
            aria-expanded="true"
            aria-controls={settingsId}
            aria-label="Close grid settings"
            onClick={() => setSettingsOpen(false)}
          >
            <GearIcon />
          </button>
        </div>
      ) : (
        <button
          type="button"
          className="task-grid-settings-toggle task-grid-settings-toggle-floating"
          aria-expanded="false"
          aria-controls={settingsId}
          aria-label="Open grid settings"
          onClick={() => setSettingsOpen(true)}
        >
          <GearIcon />
        </button>
      )}

      {settingsOpen && (
        <div id={settingsId} className="task-grid-settings">
          <div className="task-grid-settings-actions">
            <span>Explore a new combination</span>
            <button type="button" aria-label="Randomize grid settings" title="Pick a new combination of Grid settings" onClick={randomizeSettings}>
              Randomize
            </button>
          </div>
          <div className="task-grid-controls">
            <SelectField label="Preset" value={preset} options={PRESET_SELECT_OPTIONS} onChange={(value) => value !== "custom" && applyPreset(value as PresetKey)} />
            <SelectField label="Position model" value={config.position} options={POSITION_OPTIONS} onChange={(value) => setField("position", value as PositionModel)} />
            {config.position === "lanes" && (
              <>
                <SelectField label="Progress by" value={config.progress} options={PROGRESS_OPTIONS} onChange={(value) => setField("progress", value as ProgressField)} />
                <SelectField
                  label={config.progress === "stage" ? "Display direction" : "Forward direction"}
                  value={config.direction}
                  options={DIRECTION_OPTIONS}
                  onChange={(value) => setField("direction", value as Direction)}
                />
                {config.progress !== "stage" && (
                  <SelectField label="Movement memory" value={config.memory} options={MEMORY_OPTIONS} onChange={(value) => setField("memory", value as MovementMemory)} />
                )}
                <SelectField
                  label="Path labels"
                  value={config.path}
                  options={
                    config.progress === "stage"
                      ? [
                          { value: "all", label: "All steps" },
                          { value: "next", label: "Active steps" },
                          { value: "none", label: "None" },
                        ]
                      : PATH_OPTIONS
                  }
                  onChange={(value) => setField("path", value as PathLabels)}
                />
              </>
            )}
            <SelectField label="Group by" value={config.group} options={GROUP_OPTIONS} onChange={(value) => setField("group", value as GroupField)} />
            {config.position === "packed" && (
              <SelectField label="Placement" value={config.placement} options={PLACEMENT_OPTIONS} onChange={(value) => setField("placement", value as Placement)} />
            )}
            <SelectField label="Fill by" value={config.fill} options={FILL_OPTIONS} onChange={(value) => setField("fill", value as FillField)} />
            <SelectField label="Border by" value={config.border} options={BORDER_OPTIONS} onChange={(value) => setField("border", value as BorderField)} />
            <SelectField
              label={config.position === "lanes" ? "Lane order" : "Sort by"}
              value={config.sort}
              options={SORT_OPTIONS}
              onChange={(value) => setField("sort", value as SortField)}
            />
            <SelectField label="Card mode" value={config.mode} options={MODE_OPTIONS} onChange={(value) => setField("mode", value as CardMode)} />
            <RangeField label="Tile width" value={config.width} min={42} max={240} step={6} onChange={(value) => setField("width", value)} />
            <RangeField label="Tile height" value={config.height} min={42} max={170} step={2} onChange={(value) => setField("height", value)} />
            <RangeField label="Row spacing" value={config.rowSpacing} min={0} max={24} step={1} onChange={(value) => setField("rowSpacing", value)} />
            <RangeField label="Column spacing" value={config.columnSpacing} min={0} max={24} step={1} onChange={(value) => setField("columnSpacing", value)} />
            {config.position === "lanes" && (
              <RangeField label="First column width" value={config.label} min={140} max={420} step={10} onChange={(value) => setField("label", value)} />
            )}
            {config.position === "packed" && (
              <>
                <SelectField
                  label="Group tracks"
                  value={String(config.tracks)}
                  options={Array.from({ length: 8 }, (_, index) => ({ value: String(index + 1), label: String(index + 1) }))}
                  onChange={(value) => setField("tracks", Number(value))}
                />
                {config.placement === "columns" && (
                  <>
                    <SelectField
                      label="Cards per column"
                      value={String(config.columnCards)}
                      options={Array.from({ length: 6 }, (_, index) => ({
                        value: String(index + 1),
                        label: `${index + 1} card${index === 0 ? "" : "s"}`,
                      }))}
                      onChange={(value) => setField("columnCards", Number(value))}
                    />
                    <SelectField label="Column flow" value={config.columnFlow} options={COLUMN_FLOW_OPTIONS} onChange={(value) => setField("columnFlow", value as ColumnFlow)} />
                  </>
                )}
              </>
            )}
            <SelectField label="Filter" value={config.filter} options={FILTER_OPTIONS} onChange={(value) => setField("filter", value as TaskFilter)} />
            <SelectField label="Brightness" value={config.fade} options={BRIGHTNESS_OPTIONS} onChange={(value) => setField("fade", value as Brightness)} />
            <div className="task-grid-field">
              <span>Archived tasks</span>
              <Checkbox checked={showArchived} onChange={setShowArchived} label="Show archived" />
            </div>
          </div>
          <fieldset className="task-grid-properties">
            <legend>Card properties</legend>
            {CARD_PROPERTIES.map((property) => (
              <label key={property.value}>
                <input type="checkbox" checked={config.properties.includes(property.value)} onChange={() => toggleProperty(property.value)} />
                {property.label}
              </label>
            ))}
          </fieldset>
        </div>
      )}

      {settingsOpen && selected && !selectedHidden && (
        <div className="task-grid-selected" aria-live="polite">
          <strong>{selected.name}</strong>
          <span>{`${selected.repo} · ${selected.playbook} · ${selected.stage} · ${selected.status} · ${selected.sessions} sessions · updated ${selected.updatedHours}h ago`}</span>
        </div>
      )}

      {settingsOpen && (
        <div className="task-grid-plan">
          <strong>ONE GRID ENGINE</strong>
          <span>{planText}</span>
          {config.position === "lanes" && (
            <div className="task-grid-focus-actions">
              <button type="button" disabled={visibleFacts.length === 0 || visibleFacts.every((fact) => hiddenTaskIds.has(fact.id))} onClick={hideAll}>
                <VisibilityIcon hidden /> Hide all
              </button>
              <button type="button" disabled={hiddenTaskIds.size === 0} onClick={unhideAll}>
                <VisibilityIcon hidden={false} /> Unhide all
              </button>
            </div>
          )}
        </div>
      )}

      {err && (
        <div className="errbar" role="alert">
          {err}
        </div>
      )}
      {executionErrors.length > 0 && (
        <InlineStatus tone="error">
          <details className="task-grid-execution-errors">
            <summary>
              Execution status unavailable for {executionErrors.length} {executionErrors.length === 1 ? "task" : "tasks"}. Show details
            </summary>
            <ul>
              {executionErrors.map(({ ref, error }) => (
                <li key={ref.key}>
                  <strong>
                    {ref.repoPath}:{ref.slug}
                  </strong>
                  <div>{error}</div>
                </li>
              ))}
            </ul>
          </details>
        </InlineStatus>
      )}
      <div className="task-grid-board-wrap">
        {!loaded && <div className="task-grid-empty">Loading grid…</div>}
        {loaded && !err && visibleFacts.length === 0 && <div className="task-grid-empty">No tasks match this grid configuration.</div>}
        <div className="task-grid-groups" data-position={config.position} data-placement={config.placement} data-column-flow={config.columnFlow} data-card-mode={config.mode}>
          {groups.map((group) => {
            const visibilityKey = `${config.group}:${group.key}`;
            if (collapsibleGroups && hiddenGroupKeys.has(visibilityKey)) {
              return (
                <button
                  key={group.key}
                  type="button"
                  className="task-grid-group-collapsed"
                  aria-label={`Expand ${group.label} column`}
                  title={`Expand ${group.label} column`}
                  onClick={() => toggleGroup(visibilityKey)}
                >
                  <span>{group.label}</span>
                </button>
              );
            }
            return (
              <section key={group.key} className="task-grid-group">
                <div className="task-grid-group-head">
                  <span>{group.label}</span>
                  <span className="task-grid-group-count">{group.tasks.length}</span>
                  {collapsibleGroups && (
                    <button
                      type="button"
                      className="task-grid-hide task-grid-hide-group"
                      aria-label={`Hide ${group.label} column`}
                      title="Collapse column"
                      onClick={() => toggleGroup(visibilityKey)}
                    >
                      <VisibilityIcon hidden />
                    </button>
                  )}
                </div>
                {config.position === "lanes" ? (
                  <ol className="task-grid-lanes">{group.tasks.map((fact) => renderLane(fact))}</ol>
                ) : (
                  <div className="task-grid-items">{group.tasks.map((fact) => renderCard(fact))}</div>
                )}
              </section>
            );
          })}
        </div>
      </div>

      {dragPreview &&
        (() => {
          const fact = facts.find((candidate) => candidate.id === dragPreview.taskId);
          if (!fact) return null;
          const laneColor = borderTone(config.border, fact, borderToneValues, "var(--accent)");
          return (
            <div
              className="task-grid-drag-preview"
              style={
                {
                  left: dragPreview.left,
                  top: dragPreview.top,
                  width: dragPreview.width,
                  minHeight: dragPreview.height,
                  "--task-grid-lane-color": laneColor,
                } as CSSProperties
              }
              aria-hidden="true"
            >
              <div className="task-grid-drag-preview-label">
                <span className="task-grid-drag-preview-grip">⋮⋮</span>
                <span>
                  <strong>{fact.name}</strong>
                  <small>{`${fact.repo} · ${fact.playbook}`}</small>
                </span>
              </div>
              <div className="task-grid-drag-preview-track">
                <span>Moving row</span>
              </div>
            </div>
          );
        })()}

      {settingsOpen && (
        <section className="task-grid-legend" aria-label="Card color legend">
          <div className="task-grid-legend-row">
            <span className="task-grid-legend-title">FILL · {optionLabel(FILL_OPTIONS, config.fill)}</span>
            <span className="task-grid-legend-keys">
              {fillLegendValues.map((value) => (
                <span key={value} className="task-grid-legend-key">
                  <span
                    className="task-grid-legend-swatch"
                    style={{ "--task-grid-key-color": stableTone(config.fill, value, "fill", fillToneValues) } as CSSProperties}
                    aria-hidden="true"
                  />
                  {value}
                </span>
              ))}
            </span>
          </div>
          <div className="task-grid-legend-row">
            <span className="task-grid-legend-title">BORDER · {optionLabel(BORDER_OPTIONS, config.border)}</span>
            <span className="task-grid-legend-keys">
              {borderLegendValues.map((value) => (
                <span key={value} className="task-grid-legend-key">
                  <span
                    className="task-grid-legend-swatch border"
                    style={{ "--task-grid-key-color": stableTone(config.border, value, "border", borderToneValues) } as CSSProperties}
                    aria-hidden="true"
                  />
                  {value}
                </span>
              ))}
            </span>
          </div>
          <div className="task-grid-legend-note">
            <span>
              {config.position === "lanes"
                ? config.progress === "stage"
                  ? "counts = recorded execution states, not step order"
                  : `movement = ${optionLabel(MEMORY_OPTIONS, config.memory)}`
                : `brightness = ${optionLabel(BRIGHTNESS_OPTIONS, config.fade)}`}
            </span>
            <span>click any task to open</span>
          </div>
        </section>
      )}

      <ArchiveTaskModal task={pendingArchive} onCancel={() => setPendingArchive(null)} onConfirm={confirmArchive} />
    </section>
  );
}
