// WorkoutTracker.jsx
// Single-file workout log — no backend, localStorage only.
// Libraries: React and lucide-react; UI styles are scoped to this file.

import { useState, useEffect, useReducer, useRef, useMemo } from "react";
import { Analytics } from "@vercel/analytics/react";
import {
  Plus, Dumbbell, History, Settings, Trash2, X, Moon, Sun, ChevronUp, ChevronDown,
  ChevronLeft, ChevronRight, Check, RotateCcw, Trophy, NotebookPen, ClipboardPaste, Pencil, Layers,
} from "lucide-react";

// ============================================================
// CONSTANTS & UTILITIES
// ============================================================

const STORAGE_KEY = "workoutTracker_v1";
const DATE_CHECK_INTERVAL_MS = 30_000; // 30 seconds
// Rep-based 1RM estimates become unreliable past this many reps.
const MAX_E1RM_REPS = 12;
const MAX_WEIGHT = 2000;
const MAX_REPS = 1000;
// IDs of pasted patches already applied, so pasting the same one twice can't double-log.
const MAX_APPLIED_PATCHES = 200;
const MAX_PATCH_SETS = 300;
const LB_PER_KG = 2.2046226218;

const DEFAULT_CATEGORIES = [
  { id: "push", name: "Push" },
  { id: "pull", name: "Pull" },
  { id: "legs", name: "Legs" },
];

const DEFAULT_EXERCISES = [
  ["bench-press", "Bench Press", "push"],
  ["overhead-press", "Overhead Press", "push"],
  ["incline-db-press", "Incline Dumbbell Press", "push"],
  ["deadlift", "Deadlift", "pull"],
  ["barbell-row", "Barbell Row", "pull"],
  ["pull-up", "Pull-up", "pull"],
  ["squat", "Squat", "legs"],
  ["romanian-deadlift", "Romanian Deadlift", "legs"],
  ["leg-press", "Leg Press", "legs"],
].map(([id, name, categoryId]) => ({ id, name, categoryId, notes: "" }));

const DEFAULT_STATE = {
  categories: DEFAULT_CATEGORIES,
  exercises: DEFAULT_EXERCISES,
  workouts: [],
  theme: "dark",
  unit: "lbs",
  appliedPatches: [],
};

/** Returns today's date string (YYYY-MM-DD) in the user's local timezone. */
function getLocalDateString(date = new Date()) {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(date);
}

/** Moves a YYYY-MM-DD string by a number of days. */
function shiftDate(dateStr, days) {
  const [year, month, day] = dateStr.split("-").map(Number);
  return getLocalDateString(new Date(year, month - 1, day + days, 12));
}

/** Generates a unique ID for sets, workouts and exercises. */
function generateId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

/** Formats "2026-02-23" → "Monday, Feb 23" */
function formatDate(dateStr, weekday = "long") {
  if (!dateStr) return "";
  const [year, month, day] = dateStr.split("-").map(Number);
  return new Date(year, month - 1, day).toLocaleDateString("en-US", {
    weekday,
    month: "short",
    day: "numeric",
  });
}

const round1 = (value) => Math.round(value * 10) / 10;

/** A set's weight in the requested unit. */
const toUnit = (set, unit) => set.unit === unit ? set.weight : unit === "kg" ? set.weight / LB_PER_KG : set.weight * LB_PER_KG;

/** Epley estimate; an actual single counts as itself. Returns 0 when no estimate applies. */
function estimate1RM(weight, reps) {
  if (!(weight > 0) || reps < 1 || reps > MAX_E1RM_REPS) return 0;
  return reps === 1 ? weight : weight * (1 + reps / 30);
}

/** Fills in missing or malformed fields so older or hand-edited data cannot crash the app. */
function normalizeState(saved) {
  if (!saved || typeof saved !== "object") return null;
  const list = (value) => (Array.isArray(value) ? value : []);
  const text = (value, max) => (typeof value === "string" ? value.slice(0, max) : "");
  const categories = list(saved.categories).filter((c) => c && typeof c.id === "string" && typeof c.name === "string");
  const categoryIds = new Set(categories.map((c) => c.id));
  const exercises = list(saved.exercises)
    .filter((e) => e && typeof e.id === "string" && typeof e.name === "string")
    .map((e) => ({ id: e.id, name: e.name, categoryId: categoryIds.has(e.categoryId) ? e.categoryId : null, notes: text(e.notes, 20000) }));
  const exerciseIds = new Set(exercises.map((e) => e.id));
  const workouts = list(saved.workouts)
    .filter((w) => w && typeof w.date === "string")
    .map((w) => ({
      id: typeof w.id === "string" ? w.id : generateId(),
      date: w.date,
      categoryId: categoryIds.has(w.categoryId) ? w.categoryId : null,
      note: text(w.note, 20000),
      sets: list(w.sets).filter((s) => s && exerciseIds.has(s.exerciseId) && Number.isFinite(s.weight) && Number.isFinite(s.reps))
        .map((s) => ({ ...s, id: typeof s.id === "string" ? s.id : generateId(), unit: s.unit === "kg" ? "kg" : "lbs" })),
    }))
    .sort((a, b) => b.date.localeCompare(a.date));
  return {
    ...DEFAULT_STATE,
    categories,
    exercises,
    workouts,
    appliedPatches: list(saved.appliedPatches).filter((id) => typeof id === "string"),
    theme: saved.theme === "light" ? "light" : "dark",
    unit: saved.unit === "kg" ? "kg" : "lbs",
  };
}

/** Loads and parses state from localStorage. Returns null on failure. */
function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? normalizeState(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

/** Saves state to localStorage. Silent on failure. */
function saveState(state) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (e) {
    console.error("WorkoutTracker: failed to save state", e);
  }
}

// ============================================================
// RECORDS
// ============================================================

/**
 * Walks every set of an exercise in the order it was performed and derives the
 * running bests. Records are recomputed from the log, so deleting or backfilling
 * a set always leaves them correct.
 */
function exerciseStats(workouts, exerciseId, unit) {
  const rows = [];
  for (const w of workouts) {
    for (const s of w.sets) {
      if (s.exerciseId === exerciseId) rows.push({ ...s, date: w.date, w: round1(toUnit(s, unit)) });
    }
  }
  rows.sort((a, b) => a.date.localeCompare(b.date) || (a.time || "").localeCompare(b.time || ""));
  let e1rm = null, heaviest = null, mostReps = null;
  const byWeight = new Map(), prs = new Map(), sessions = new Map();
  for (const r of rows) {
    const estimate = estimate1RM(r.w, r.reps);
    const flags = [];
    if (estimate > 0 && (!e1rm || estimate > e1rm.value + 1e-9)) {
      if (e1rm) flags.push("1RM PR");
      e1rm = { value: estimate, weight: r.w, reps: r.reps, date: r.date };
    }
    const previous = byWeight.get(r.w);
    if (!previous || r.reps > previous.reps) {
      if (previous) flags.push("Rep PR");
      byWeight.set(r.w, { weight: r.w, reps: r.reps, date: r.date });
    }
    if (!heaviest || r.w > heaviest.weight) heaviest = { weight: r.w, reps: r.reps, date: r.date };
    if (!mostReps || r.reps > mostReps.reps) mostReps = { weight: r.w, reps: r.reps, date: r.date };
    if (flags.length) prs.set(r.id, flags);
    const day = sessions.get(r.date) || { date: r.date, sets: [], e1rm: 0 };
    day.sets.push(r);
    day.e1rm = Math.max(day.e1rm, estimate);
    sessions.set(r.date, day);
  }
  return {
    count: rows.length,
    last: rows[rows.length - 1] || null,
    e1rm, heaviest, mostReps, prs,
    repRecords: [...byWeight.values()].sort((a, b) => b.weight - a.weight),
    sessions: [...sessions.values()],
  };
}

// ============================================================
// JSON PATCHES (workouts logged from a chat with an assistant)
// ============================================================
//
// Format (code fences and surrounding text are ignored):
// {
//   "workoutTracker": "patch",
//   "id": "2026-10-25-push",            // optional; the same id is only applied once
//   "unit": "lbs",                      // optional; defaults to the app's unit
//   "workouts": [{
//     "date": "2026-10-25",             // optional = today
//     "category": "Push",               // optional; created if new
//     "note": "Felt strong",            // optional
//     "exercises": [
//       { "name": "Bench Press", "notes": "Pause first rep", "sets": [{ "weight": 185, "reps": 5 }] }
//     ]
//   }]
// }
// A single workout object (with "exercises") or a bare array of workouts is also accepted.

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Pulls the first JSON object or array out of pasted text (e.g. a ```json block). */
function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fenced ? fenced[1] : text).trim();
  const start = body.search(/[[{]/);
  if (start < 0) throw new Error("No JSON found in the pasted text.");
  const open = body[start], close = open === "{" ? "}" : "]";
  const end = body.lastIndexOf(close);
  if (end < start) throw new Error("The JSON looks cut off. Copy the whole block.");
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    throw new Error("That isn't valid JSON. Copy the whole block and try again.");
  }
}

/** Validates pasted text into { id, unit, workouts }. Throws an Error with a readable message. */
function parsePatch(text, defaultUnit, today = getLocalDateString()) {
  const raw = extractJson(text);
  const patch = Array.isArray(raw) ? { workouts: raw } : raw;
  if (!patch || typeof patch !== "object") throw new Error("Expected an object with a \"workouts\" list.");
  const list = patch.workouts ?? (patch.exercises ? [patch] : null);
  if (!Array.isArray(list) || !list.length) throw new Error("Nothing to log: add a \"workouts\" list.");
  const unit = patch.unit == null ? defaultUnit : String(patch.unit).toLowerCase().startsWith("kg") ? "kg" : "lbs";
  let setCount = 0;
  const workouts = list.map((w, i) => {
    const label = "Workout " + (i + 1);
    if (!w || typeof w !== "object") throw new Error(label + " isn't an object.");
    const date = w.date == null || w.date === "" ? today : String(w.date);
    if (!DATE_RE.test(date) || Number.isNaN(new Date(date + "T12:00:00").getTime())) throw new Error(label + ": date must look like 2026-10-25.");
    if (date > today) throw new Error(label + ": date is in the future.");
    if (!Array.isArray(w.exercises ?? [])) throw new Error(label + ": \"exercises\" must be a list.");
    const exercises = (w.exercises ?? []).map((e, j) => {
      const where = label + ", exercise " + (j + 1);
      if (!e || typeof e !== "object") throw new Error(where + " isn't an object.");
      const name = String(e.name ?? "").trim().slice(0, 120);
      if (!name) throw new Error(where + " needs a name.");
      if (!Array.isArray(e.sets ?? [])) throw new Error(where + ": \"sets\" must be a list.");
      const sets = (e.sets ?? []).map((s, k) => {
        const weight = Number(s?.weight ?? 0), reps = Number(s?.reps);
        if (!Number.isFinite(weight) || weight < 0 || weight > MAX_WEIGHT) throw new Error(name + " set " + (k + 1) + ": weight must be 0–" + MAX_WEIGHT + ".");
        if (!Number.isInteger(reps) || reps < 1 || reps > MAX_REPS) throw new Error(name + " set " + (k + 1) + ": reps must be a whole number 1–" + MAX_REPS + ".");
        return { weight: round1(weight), reps };
      });
      setCount += sets.length;
      return { name, sets, notes: typeof e.notes === "string" ? e.notes.trim().slice(0, 2000) : "" };
    });
    const category = w.category == null || w.category === "" ? null : String(w.category).trim().slice(0, 40) || null;
    return { date, category, note: typeof w.note === "string" ? w.note.trim().slice(0, 2000) : "", exercises };
  });
  if (setCount > MAX_PATCH_SETS) throw new Error("Too many sets in one paste (max " + MAX_PATCH_SETS + ").");
  if (!workouts.some((w) => w.exercises.length || w.note || w.category)) throw new Error("Nothing to log: the patch has no exercises.");
  const id = patch.id == null || patch.id === "" ? null : String(patch.id).slice(0, 100);
  return { id, unit, workouts };
}

// ============================================================
// REDUCER
// ============================================================

const sameName = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** Returns the workouts list with the given date's workout updated (created if missing). */
function upsertWorkout(workouts, date, update) {
  const existing = workouts.find((w) => w.date === date);
  const base = existing || { id: generateId(), date, categoryId: null, note: "", sets: [] };
  const next = update(base);
  return existing
    ? workouts.map((w) => (w === existing ? next : w))
    : [...workouts, next].sort((a, b) => b.date.localeCompare(a.date));
}

function makeSet({ exerciseId, weight, reps, unit }) {
  return {
    id: generateId(),
    exerciseId,
    weight: Math.max(0, Math.min(MAX_WEIGHT, round1(Number(weight) || 0))),
    reps: Math.max(1, Math.min(MAX_REPS, Math.round(Number(reps) || 1))),
    unit: unit === "kg" ? "kg" : "lbs",
    time: new Date().toISOString(),
  };
}

function reducer(state, action) {
  switch (action.type) {
    case "INIT":
      return action.payload;

    case "ADD_SET": {
      const { date } = action.payload;
      const set = makeSet(action.payload);
      const exercise = state.exercises.find((e) => e.id === set.exerciseId);
      return {
        ...state,
        workouts: upsertWorkout(state.workouts, date, (w) => ({
          ...w,
          // A new workout takes the day category of the first exercise logged.
          categoryId: w.categoryId ?? (w.sets.length ? null : exercise?.categoryId ?? null),
          sets: [...w.sets, set],
        })),
      };
    }

    case "DELETE_SET": {
      const { date, id } = action.payload;
      return {
        ...state,
        workouts: state.workouts.map((w) => (w.date === date ? { ...w, sets: w.sets.filter((s) => s.id !== id) } : w)),
      };
    }

    case "UPDATE_WORKOUT": {
      const { date, ...fields } = action.payload;
      return { ...state, workouts: upsertWorkout(state.workouts, date, (w) => ({ ...w, ...fields })) };
    }

    case "DELETE_WORKOUT":
      return { ...state, workouts: state.workouts.filter((w) => w.date !== action.payload) };

    case "ADD_EXERCISE": {
      const { id, name, categoryId } = action.payload;
      return { ...state, exercises: [...state.exercises, { id, name: name.trim().slice(0, 120), categoryId: categoryId || null, notes: "" }] };
    }

    case "UPDATE_EXERCISE": {
      const { id, ...fields } = action.payload;
      return { ...state, exercises: state.exercises.map((e) => (e.id === id ? { ...e, ...fields } : e)) };
    }

    case "DELETE_EXERCISE":
      return {
        ...state,
        exercises: state.exercises.filter((e) => e.id !== action.payload),
        workouts: state.workouts.map((w) => ({ ...w, sets: w.sets.filter((s) => s.exerciseId !== action.payload) })),
      };

    case "ADD_CATEGORY":
      return { ...state, categories: [...state.categories, { id: action.payload.id, name: action.payload.name.trim().slice(0, 40) }] };

    case "RENAME_CATEGORY":
      return { ...state, categories: state.categories.map((c) => (c.id === action.payload.id ? { ...c, name: action.payload.name.trim().slice(0, 40) } : c)) };

    case "DELETE_CATEGORY": {
      const id = action.payload;
      return {
        ...state,
        categories: state.categories.filter((c) => c.id !== id),
        exercises: state.exercises.map((e) => (e.categoryId === id ? { ...e, categoryId: null } : e)),
        workouts: state.workouts.map((w) => (w.categoryId === id ? { ...w, categoryId: null } : w)),
      };
    }

    case "APPLY_PATCH": {
      const { id, unit, workouts } = action.payload;
      if (id && (state.appliedPatches || []).includes(id)) return state;
      let next = state;
      for (const workout of workouts) {
        // A pasted category labels a new or unlabeled day; it never relabels one you already set.
        const existingCategory = next.workouts.find((w) => w.date === workout.date)?.categoryId ?? null;
        let categoryId = null;
        if (workout.category) {
          const found = next.categories.find((c) => sameName(c.name, workout.category));
          categoryId = found?.id ?? generateId();
          if (!found) next = reducer(next, { type: "ADD_CATEGORY", payload: { id: categoryId, name: workout.category } });
        }
        for (const entry of workout.exercises) {
          let exercise = next.exercises.find((e) => sameName(e.name, entry.name));
          if (!exercise) {
            const exerciseId = generateId();
            next = reducer(next, { type: "ADD_EXERCISE", payload: { id: exerciseId, name: entry.name, categoryId } });
            exercise = next.exercises.find((e) => e.id === exerciseId);
          }
          if (entry.notes) {
            const notes = (exercise.notes ? exercise.notes + "\n" : "") + workout.date + ": " + entry.notes;
            next = reducer(next, { type: "UPDATE_EXERCISE", payload: { id: exercise.id, notes } });
          }
          for (const set of entry.sets) {
            next = reducer(next, { type: "ADD_SET", payload: { ...set, unit, exerciseId: exercise.id, date: workout.date } });
          }
        }
        const fields = {};
        if (categoryId && !existingCategory) fields.categoryId = categoryId;
        if (workout.note) {
          const current = next.workouts.find((w) => w.date === workout.date)?.note;
          fields.note = current ? current + "\n" + workout.note : workout.note;
        }
        if (Object.keys(fields).length || !next.workouts.some((w) => w.date === workout.date)) {
          next = reducer(next, { type: "UPDATE_WORKOUT", payload: { date: workout.date, ...fields } });
        }
      }
      if (id) next = { ...next, appliedPatches: [...(next.appliedPatches || []), id].slice(-MAX_APPLIED_PATCHES) };
      return next;
    }

    case "SET_THEME":
      return { ...state, theme: action.payload };

    case "SET_UNIT":
      return { ...state, unit: action.payload };

    case "RESET_ALL":
      return DEFAULT_STATE;

    default:
      return state;
  }
}

// ============================================================
// UI
// ============================================================

const UI_CSS = `
.wt { --bg:#f3f4f6; --surface:#fff; --subtle:#f0f2f5; --ink:#20232b; --muted:#646b78; --line:#e6e8ed; --green:#16744f; --green-soft:#e7f4ed; --blue:#2767bf; --glass:rgba(249,250,252,.88); --danger:#bd3542; --amber:#a3640a; --amber-soft:#fbf0dc; min-height:100dvh; background:var(--bg); color:var(--ink); font:400 16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; color-scheme:light; }
.wt[data-theme="dark"] { --bg:#111416; --surface:#1d2225; --subtle:#282e32; --ink:#f3f5f4; --muted:#a5aeb3; --line:#333a3f; --green:#7bd6ac; --green-soft:#253e34; --blue:#91bcff; --glass:rgba(26,31,34,.91); --danger:#ff919b; --amber:#f0b45a; --amber-soft:#3d3222; color-scheme:dark; }
.wt * { box-sizing:border-box; } .wt button,.wt input,.wt select,.wt textarea { font:inherit; }
.wt button { cursor:pointer; touch-action:manipulation; -webkit-tap-highlight-color:transparent; transition:background-color .15s,transform .15s,opacity .15s; }
.wt button:active { transform:scale(.97); transition-duration:0s; }
.wt button:disabled { opacity:.45; cursor:default; } .wt :focus-visible { outline:3px solid var(--blue); outline-offset:4px; }
.wt h1,.wt h2,.wt h3,.wt p { margin:0; } .wt h1 { font-size:clamp(2.1rem,5vw,2.85rem); line-height:1.1; letter-spacing:-.045em; font-weight:750; }
.wt h2 { font-size:1.18rem; line-height:1.3; letter-spacing:-.025em; font-weight:700; } .wt h3 { font-size:1rem; font-weight:650; }
.wt small,.wt .muted { color:var(--muted); } .wt small { font-size:.8rem; }
.wt .eyebrow { color:var(--muted); font-size:.72rem; font-weight:650; letter-spacing:.11em; text-transform:uppercase; }
.wt .shell { max-width:1040px; margin:auto; padding:28px 32px 136px; }
.wt .brand { display:flex; align-items:center; gap:9px; color:var(--green); font-size:.9rem; font-weight:750; letter-spacing:-.02em; margin-bottom:35px; }
.wt .header { display:flex; align-items:center; justify-content:space-between; gap:16px; margin-bottom:28px; }
.wt .header .eyebrow { margin-bottom:9px; }
.wt .row { display:flex; align-items:center; gap:12px; } .wt .between { justify-content:space-between; } .wt .wrap { flex-wrap:wrap; }
.wt .stack { display:grid; gap:20px; } .wt .columns { display:grid; grid-template-columns:.9fr 1.1fr; gap:24px; align-items:start; }
.wt .sticky { position:sticky; top:20px; }
.wt .card { padding:0; background:var(--surface); border:1px solid var(--line); border-radius:25px; overflow:hidden; box-shadow:0 3px 9px #00000002; }
.wt .pad { padding:24px; } .wt .section-head { display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom:18px; }
.wt .button { min-height:48px; border:0; border-radius:15px; display:inline-flex; justify-content:center; align-items:center; gap:8px; padding:11px 18px; font-weight:650; background:var(--subtle); color:var(--ink); }
.wt .primary { background:var(--green); color:var(--surface); } .wt .soft { background:var(--green-soft); color:var(--green); } .wt .danger { color:var(--danger); }
.wt .icon { width:44px; height:44px; flex-shrink:0; padding:0; border-radius:50%; border:0; display:inline-flex; align-items:center; justify-content:center; color:var(--muted); background:var(--subtle); }
.wt .full { width:100%; } .wt .text-button { border:0; background:transparent; min-height:44px; color:var(--green); font-weight:650; padding:8px; }
.wt .number { font-size:2.9rem; font-weight:730; letter-spacing:-.055em; line-height:1.15; font-variant-numeric:tabular-nums; }
.wt .stats { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:16px; } .wt .stats.three { grid-template-columns:repeat(3,minmax(0,1fr)); gap:12px; }
.wt .stat { padding:16px; background:var(--subtle); border-radius:17px; min-width:0; }
.wt .stat strong { display:block; font-size:1.45rem; letter-spacing:-.035em; font-variant-numeric:tabular-nums; overflow-wrap:anywhere; }
.wt .stats.three .stat strong { font-size:1.2rem; }
.wt .note { font-size:.84rem; color:var(--muted); line-height:1.55; }
.wt .notes-text { white-space:pre-wrap; overflow-wrap:anywhere; font-size:.88rem; line-height:1.5; padding:12px 14px; border-radius:13px; background:var(--subtle); }
.wt .item-row { padding:15px 20px; border-top:1px solid var(--line); display:flex; gap:12px; align-items:center; }
.wt .item-row:first-child { border-top:0; } .wt .history-day + .history-day { border-top:1px solid var(--line); }
.wt .grow { flex:1; min-width:0; } .wt .item-name { font-weight:600; overflow-wrap:anywhere; } .wt .numeric { text-align:right; font-variant-numeric:tabular-nums; flex-shrink:0; }
.wt .list-button { width:100%; text-align:left; border:0; background:transparent; color:var(--ink); }
.wt .empty { text-align:center; padding:40px 24px; } .wt .empty-icon { width:62px; height:62px; border-radius:22px; margin:0 auto 16px; display:grid; place-items:center; background:var(--green-soft); color:var(--green); }
.wt .empty p { max-width:310px; margin:8px auto 20px; font-size:.9rem; color:var(--muted); }
.wt .nav { position:fixed; z-index:20; bottom:max(16px,env(safe-area-inset-bottom)); left:50%; transform:translateX(-50%); display:flex; width:min(460px,calc(100% - 24px)); padding:7px; background:var(--glass); backdrop-filter:blur(24px) saturate(150%); border:1px solid var(--line); border-radius:25px; box-shadow:0 8px 36px #00000013; }
.wt .nav button { flex:1; min-height:59px; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:4px; border:0; border-radius:19px; background:transparent; color:var(--muted); font-size:.68rem; font-weight:600; }
.wt .nav button[aria-current="page"] { background:var(--green-soft); color:var(--green); }
.wt .segments { display:flex; padding:4px; border-radius:13px; background:var(--subtle); gap:3px; }
.wt .segments button { flex:1; min-height:44px; padding:8px 13px; border:0; border-radius:10px; background:transparent; color:var(--muted); font-weight:600; }
.wt .segments button[aria-pressed="true"] { background:var(--surface); color:var(--ink); box-shadow:0 2px 6px #00000008; }
.wt .chips { display:flex; gap:8px; flex-wrap:wrap; }
.wt .chips button { min-height:44px; padding:8px 16px; border:1px solid var(--line); border-radius:999px; background:var(--subtle); color:var(--muted); font-weight:600; }
.wt .chips button[aria-pressed="true"] { background:var(--green); border-color:var(--green); color:var(--surface); }
.wt .history-heading { width:100%; text-align:left; padding:20px; border:0; background:transparent; color:var(--ink); display:flex; gap:12px; align-items:center; }
.wt .history-heading small { display:block; margin-top:4px; } .wt .history-details { border-top:1px solid var(--line); } .wt .history-actions { padding:12px 20px; display:flex; justify-content:space-between; align-items:center; gap:10px; }
.wt .badge { display:inline-flex; align-items:center; gap:5px; font-size:.72rem; padding:4px 8px; border-radius:7px; color:var(--muted); background:var(--subtle); white-space:nowrap; }
.wt .badge.pr { color:var(--amber); background:var(--amber-soft); font-weight:650; } .wt .badge.cat { color:var(--green); background:var(--green-soft); }
.wt .history-heading .badge { margin:6px 6px 0 0; }
.wt .set-row { display:flex; align-items:center; gap:10px; padding:9px 0; border-top:1px solid var(--line); font-variant-numeric:tabular-nums; }
.wt .set-row:first-child { border-top:0; } .wt .set-index { width:24px; color:var(--muted); font-size:.8rem; text-align:center; flex-shrink:0; }
.wt .set-row .icon { width:38px; height:38px; background:transparent; }
.wt .nowrap { white-space:nowrap; } .wt .block { display:block; } .wt .set-flags { display:flex; flex-wrap:wrap; justify-content:flex-end; gap:5px; }
.wt .set-form { display:grid; grid-template-columns:1fr 1fr auto; gap:10px; align-items:end; margin-top:14px; }
.wt .set-form label { font-size:.76rem; color:var(--muted); } .wt .set-form input { min-height:48px; }
.wt .ex-head { display:flex; gap:12px; align-items:flex-start; justify-content:space-between; }
.wt .ex-meta { display:flex; gap:6px; flex-wrap:wrap; margin-top:6px; }
.wt .ex-notes { margin-top:12px; font-size:.84rem; color:var(--muted); white-space:pre-wrap; overflow-wrap:anywhere; display:-webkit-box; -webkit-line-clamp:3; -webkit-box-orient:vertical; overflow:hidden; border-left:3px solid var(--line); padding-left:10px; }
.wt .table { width:100%; border-collapse:collapse; font-variant-numeric:tabular-nums; font-size:.9rem; }
.wt .table th { text-align:left; font-size:.72rem; letter-spacing:.08em; text-transform:uppercase; color:var(--muted); font-weight:650; padding:0 0 8px; }
.wt .table td { padding:9px 0; border-top:1px solid var(--line); } .wt .table td:last-child,.wt .table th:last-child { text-align:right; }
.wt .bars { position:relative; height:110px; display:flex; align-items:end; gap:6px; margin:22px 0 8px; }
.wt .bar { flex:1; height:100%; display:flex; flex-direction:column; align-items:center; justify-content:end; gap:6px; } .wt .bar span { width:100%; max-width:30px; min-height:3px; border-radius:5px; background:var(--green); } .wt .bar small { font-size:.62rem; height:15px; line-height:15px; }
.wt .chart { width:100%; height:200px; margin-top:16px; } .wt .chart svg { overflow:visible; width:100%; height:100%; }
.wt textarea { font:400 .92rem/1.5 inherit; resize:vertical; } .wt textarea.code { font:500 .85rem/1.45 ui-monospace,SFMono-Regular,Menlo,monospace; }
.wt .header-actions { display:flex; gap:10px; align-items:center; }
.wt label { display:grid; gap:7px; font-size:.86rem; font-weight:600; } .wt input,.wt select,.wt textarea { min-width:0; width:100%; min-height:50px; padding:12px 14px; background:var(--subtle); color:var(--ink); border:1px solid var(--line); border-radius:13px; outline-offset:2px; }
.wt input::placeholder,.wt textarea::placeholder { color:var(--muted); font-weight:400; } .wt input[aria-invalid="true"],.wt textarea[aria-invalid="true"] { border-color:var(--danger); }
.wt input[type="number"] { appearance:textfield; -moz-appearance:textfield; } .wt input[type="number"]::-webkit-inner-spin-button { -webkit-appearance:none; margin:0; }
.wt .fields { display:grid; grid-template-columns:1fr 1fr; gap:14px; } .wt .form { display:grid; gap:19px; }
.wt .error { color:var(--danger); font-size:.86rem; } .wt .success { display:flex; align-items:center; gap:8px; padding:12px 14px; background:var(--green-soft); color:var(--green); border-radius:12px; font-size:.86rem; }
.wt .date-nav { display:flex; align-items:center; gap:8px; } .wt .date-nav input { text-align:center; }
.wt .overlay { position:fixed; inset:0; z-index:40; display:flex; justify-content:center; align-items:end; }
.wt .scrim { position:absolute; inset:0; background:rgba(0,0,0,.42); backdrop-filter:blur(4px); }
.wt .sheet { position:relative; width:min(100%,560px); max-height:92dvh; overflow:auto; overscroll-behavior:contain; border-radius:30px 30px 0 0; background:var(--surface); border:1px solid var(--line); box-shadow:0 -10px 70px #00000024; padding:0 26px max(28px,env(safe-area-inset-bottom)); will-change:transform; }
.wt .handle { display:block; width:100%; height:44px; border:0; background:transparent; touch-action:none; cursor:grab; } .wt .handle span { display:block; width:36px; height:5px; border-radius:9px; background:var(--line); margin:auto; }
.wt .sheet-head { display:flex; align-items:center; justify-content:space-between; gap:14px; margin-bottom:24px; }
.wt .toast { position:fixed; z-index:60; bottom:108px; left:50%; transform:translateX(-50%); width:max-content; max-width:calc(100% - 32px); border-radius:15px; background:var(--ink); color:var(--surface); padding:13px 20px; box-shadow:0 8px 30px #0002; font-size:.9rem; pointer-events:none; }
@media(max-width:800px) { .wt .shell { padding:24px 18px 126px; } .wt .brand { margin-bottom:27px; } .wt .columns { grid-template-columns:1fr; gap:20px; } .wt .sticky { position:static; } .wt .header { margin-bottom:24px; } .wt .pad { padding:20px; } .wt .header-actions .button { padding:12px; } }
@media(max-width:420px) { .wt .item-row { padding:14px; gap:8px; } .wt .fields { grid-template-columns:1fr; } .wt .stats.three .stat { padding:12px; } .wt .header-actions .button span { display:none; } }
@media(prefers-reduced-motion:reduce) { .wt *, .wt *::before,.wt *::after { transition:none!important; scroll-behavior:auto!important; } .wt button:active { transform:none; } }
@media(prefers-reduced-transparency:reduce) { .wt .nav { background:var(--surface); backdrop-filter:none; } .wt .scrim { backdrop-filter:none; } }
@media(prefers-contrast:more) { .wt { --muted:var(--ink); } .wt .card,.wt .nav,.wt input,.wt .sheet { border-color:var(--ink); } }
`;

const number = (value) => Number(value || 0).toLocaleString(undefined, { maximumFractionDigits: 1 });
const weightText = (weight, unit) => (weight > 0 ? number(weight) + " " + unit : "Bodyweight");
const formatSet = (weight, reps, unit) => (weight > 0 ? number(weight) + " " + unit + " × " + reps : reps + (reps === 1 ? " rep" : " reps"));
const plural = (count, word) => number(count) + " " + word + (count === 1 ? "" : "s");

function Empty({ icon: Icon = Dumbbell, title, children, action, onAction }) {
  return <div className="empty"><div className="empty-icon"><Icon size={27} strokeWidth={1.6} /></div><h3>{title}</h3>{children ? <p>{children}</p> : <div style={{ height: 16 }} />}{action && <button className="button soft" onClick={onAction}><Plus size={18} />{action}</button>}</div>;
}

function Sheet({ title, onClose, children }) {
  const panel = useRef(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const physics = useRef({ y: 600, v: 0, target: 0, dragging: false, closing: false });
  const gesture = useRef(null);
  const dismiss = () => {
    const p = physics.current;
    p.closing = true;
    p.target = (panel.current?.offsetHeight || 600) + 40;
  };
  useEffect(() => {
    const el = panel.current;
    const previous = document.activeElement;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    physics.current.y = media.matches ? 0 : el.offsetHeight + 40;
    el.focus({ preventScroll: true });
    let frame, last;
    const tick = (now) => {
      const p = physics.current;
      const dt = Math.min((now - (last || now)) / 1000, .032);
      last = now;
      if (media.matches) {
        p.y = 0;
        if (p.closing) { closeRef.current(); return; }
      } else if (!p.dragging) {
        p.v += ((p.target - p.y) * 390 - p.v * 39) * dt;
        p.y += p.v * dt;
        if (p.closing && Math.abs(p.y - p.target) < 1 && Math.abs(p.v) < 8) { closeRef.current(); return; }
      }
      el.style.transform = "translateY(" + p.y + "px)";
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      document.body.style.overflow = overflow;
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);
  const keyDown = (e) => {
    if (e.key === "Escape") { e.preventDefault(); dismiss(); }
    if (e.key === "Tab") {
      const items = [...panel.current.querySelectorAll('button:not(:disabled),input:not(:disabled),select,textarea,[tabindex="0"]')];
      const first = items[0], last = items[items.length - 1];
      if (e.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) { e.preventDefault(); last?.focus(); }
      else if (!e.shiftKey && (document.activeElement === last || document.activeElement === panel.current)) { e.preventDefault(); first?.focus(); }
    }
  };
  const release = (e, cancelled = false) => {
    if (!gesture.current) return;
    const p = physics.current;
    if (e.timeStamp - gesture.current.time > 100) p.v = 0;
    p.dragging = false;
    p.closing = !cancelled && p.y + p.v * .16 > 150;
    p.target = p.closing ? panel.current.offsetHeight + 40 : 0;
    gesture.current = null;
  };
  return <div className="overlay">
    <div className="scrim" onClick={dismiss} aria-hidden="true" />
    <section className="sheet" ref={panel} role="dialog" aria-modal="true" aria-labelledby="sheet-title" tabIndex={-1} onKeyDown={keyDown}>
      <button className="handle" aria-label="Close sheet; drag down to dismiss" onClick={(e) => { if (e.detail === 0) dismiss(); }}
        onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); const p = physics.current; p.dragging = true; p.closing = false; gesture.current = { start: e.clientY, origin: p.y, last: e.clientY, time: e.timeStamp }; }}
        onPointerMove={(e) => { const g = gesture.current; if (!g) return; const p = physics.current; const delta = e.clientY - g.start; p.y = Math.max(0, g.origin + delta); p.v = (e.clientY - g.last) / Math.max(1, e.timeStamp - g.time) * 1000; g.last = e.clientY; g.time = e.timeStamp; }}
        onPointerUp={(e) => release(e)} onPointerCancel={(e) => release(e, true)}>
        <span />
      </button>
      <div className="sheet-head"><h2 id="sheet-title">{title}</h2><button className="icon" aria-label="Close" onClick={dismiss}><X size={20} /></button></div>
      {children}
    </section>
  </div>;
}

/** "Best 1RM 245 lbs" summary for an exercise, or a prompt when nothing is logged yet. */
function RecordBadges({ stats, unit }) {
  if (!stats?.count) return <span className="badge">No sets yet</span>;
  return <>
    {stats.e1rm && <span className="badge pr"><Trophy size={12} />{stats.e1rm.reps === 1 ? "1RM " : "Est. 1RM "}{number(stats.e1rm.value)} {unit}</span>}
    {!stats.e1rm && <span className="badge pr"><Trophy size={12} />Best {formatSet(stats.mostReps.weight, stats.mostReps.reps, unit)}</span>}
  </>;
}

function SetRows({ sets, unit, prs, onDelete }) {
  return <div>{sets.map((set, i) => {
    const flags = prs?.get(set.id) || [];
    const w = round1(toUnit(set, unit));
    const estimate = estimate1RM(w, set.reps);
    return <div className="set-row" key={set.id}>
      <span className="set-index">{i + 1}</span>
      <div className="grow"><strong className="nowrap">{formatSet(w, set.reps, unit)}</strong>{estimate > 0 && set.reps > 1 && <small className="block">est. 1RM {number(estimate)}</small>}</div>
      {flags.length > 0 && <div className="set-flags">{flags.map((f) => <span className="badge pr" key={f}><Trophy size={12} />{f}</span>)}</div>}
      {onDelete && <button className="icon" aria-label={"Delete set " + (i + 1)} onClick={() => onDelete(set)}><Trash2 size={16} /></button>}
    </div>;
  })}</div>;
}

function ExerciseCard({ exercise, sets, stats, unit, date, categoryName, dispatch, notify, onOpen, onDeleteSet }) {
  const last = sets.length ? sets[sets.length - 1] : stats.last;
  const [form, setForm] = useState({ weight: last ? String(round1(toUnit(last, unit))) : "", reps: last ? String(last.reps) : "" });
  const [error, setError] = useState("");
  const weightRef = useRef(null);
  const submit = (e) => {
    e.preventDefault();
    const weight = form.weight === "" ? 0 : Number(form.weight), reps = Number(form.reps);
    if (!Number.isFinite(weight) || weight < 0 || weight > MAX_WEIGHT) { setError("Weight must be 0–" + number(MAX_WEIGHT) + " " + unit + " (0 for bodyweight)."); return; }
    if (!Number.isInteger(reps) || reps < 1 || reps > MAX_REPS) { setError("Reps must be a whole number from 1."); return; }
    // Compare against the records before this set to announce a new best.
    const w = round1(weight), estimate = estimate1RM(w, reps);
    const atWeight = stats.repRecords.find((r) => r.weight === w);
    let message = "Set logged: " + formatSet(w, reps, unit) + ".";
    if (stats.e1rm && estimate > stats.e1rm.value + 1e-9) message = "New 1RM PR: " + (reps === 1 ? "" : "est. ") + number(estimate) + " " + unit + "!";
    else if (atWeight && reps > atWeight.reps) message = "Rep PR: " + plural(reps, "rep") + " at " + weightText(w, unit) + "!";
    dispatch({ type: "ADD_SET", payload: { date, exerciseId: exercise.id, weight: w, reps, unit } });
    notify(message);
    setError("");
    weightRef.current?.focus();
  };
  return <section className="card pad">
    <div className="ex-head">
      <div className="grow"><h2>{exercise.name}</h2><div className="ex-meta"><RecordBadges stats={stats} unit={unit} />{categoryName && <span className="badge cat">{categoryName}</span>}{stats.last && !sets.length && <span className="badge">Last {formatSet(round1(toUnit(stats.last, unit)), stats.last.reps, unit)}</span>}</div></div>
      <button className="icon" aria-label={"Notes and records for " + exercise.name} title="Notes & records" onClick={onOpen}><NotebookPen size={18} /></button>
    </div>
    {exercise.notes && <p className="ex-notes">{exercise.notes}</p>}
    {sets.length > 0 && <div style={{ marginTop: 12 }}><SetRows sets={sets} unit={unit} prs={stats.prs} onDelete={onDeleteSet} /></div>}
    <form className="set-form" onSubmit={submit}>
      <label>Weight · {unit}<input ref={weightRef} type="number" inputMode="decimal" min="0" max={MAX_WEIGHT} step="any" placeholder="0 = BW" value={form.weight} onChange={(e) => { setForm((f) => ({ ...f, weight: e.target.value })); setError(""); }} /></label>
      <label>Reps<input type="number" inputMode="numeric" min="1" max={MAX_REPS} step="1" required placeholder="0" value={form.reps} onChange={(e) => { setForm((f) => ({ ...f, reps: e.target.value })); setError(""); }} /></label>
      <button className="button primary" type="submit" aria-label={"Add set of " + exercise.name}><Plus size={19} /></button>
    </form>
    {error && <p className="error" role="alert" style={{ marginTop: 10 }}>{error}</p>}
  </section>;
}

function WorkoutScreen({ state, date, setDate, today, allStats, pinned, dispatch, notify, onAddExercise, onOpenExercise, onDeleteSet }) {
  const workout = state.workouts.find((w) => w.date === date);
  const [category, setCategory] = useState(workout?.categoryId ?? null);
  const [note, setNote] = useState(workout?.note ?? "");
  // Follow the stored workout when the date changes or another tab edits it.
  useEffect(() => { setCategory(workout?.categoryId ?? null); }, [date, workout?.categoryId]);
  useEffect(() => { setNote(workout?.note ?? ""); }, [date, workout?.note]);
  const sets = workout?.sets ?? [];
  const usedIds = [...new Set(sets.map((s) => s.exerciseId))];
  // The day's category acts as a template: show its exercises, then anything else logged or picked.
  const inCategory = state.exercises.filter((e) => category && e.categoryId === category);
  const shown = [...inCategory, ...[...new Set([...usedIds, ...pinned])]
    .map((id) => state.exercises.find((e) => e.id === id))
    .filter((e) => e && !inCategory.includes(e))];
  const categoryName = (id) => state.categories.find((c) => c.id === id)?.name;
  const chooseCategory = (id) => { setCategory(id); if (workout || id) dispatch({ type: "UPDATE_WORKOUT", payload: { date, categoryId: id } }); };
  const saveNote = () => { if (note !== (workout?.note ?? "")) { dispatch({ type: "UPDATE_WORKOUT", payload: { date, note } }); notify("Workout note saved."); } };
  const volume = sets.reduce((sum, s) => sum + toUnit(s, state.unit) * s.reps, 0);
  return <div className="columns">
    <div className="stack sticky">
      <section className="card pad">
        <div className="section-head"><h2>Session</h2>{date !== today && <button className="text-button" onClick={() => setDate(today)}>Back to today</button>}</div>
        <div className="date-nav">
          <button className="icon" aria-label="Previous day" onClick={() => setDate(shiftDate(date, -1))}><ChevronLeft size={20} /></button>
          <input type="date" aria-label="Workout date" max={today} value={date} onChange={(e) => { if (e.target.value && e.target.value <= today) setDate(e.target.value); }} />
          <button className="icon" aria-label="Next day" disabled={date >= today} onClick={() => setDate(shiftDate(date, 1))}><ChevronRight size={20} /></button>
        </div>
        <p className="eyebrow" style={{ margin: "22px 0 10px" }}>Day</p>
        {state.categories.length ? <div className="chips">{state.categories.map((c) => <button key={c.id} aria-pressed={category === c.id} onClick={() => chooseCategory(category === c.id ? null : c.id)}>{c.name}</button>)}</div>
          : <p className="note">Add day categories on the Exercises tab.</p>}
        <div className="stats three" style={{ marginTop: 22 }}>
          <div className="stat"><small>Exercises</small><strong>{usedIds.length}</strong></div>
          <div className="stat"><small>Sets</small><strong>{sets.length}</strong></div>
          <div className="stat"><small>Volume</small><strong>{number(Math.round(volume))}</strong><small>{state.unit}</small></div>
        </div>
        <label style={{ marginTop: 20 }}>Workout note<textarea rows={3} maxLength={20000} value={note} onChange={(e) => setNote(e.target.value)} onBlur={saveNote} placeholder="How it went, sleep, energy…" /></label>
      </section>
    </div>
    <div className="stack">
      {shown.length === 0 && <section className="card"><Empty title={category ? "No exercises in this day yet" : "Pick a day to start"} action="Add exercise" onAction={onAddExercise}>{category ? "Add exercises to " + categoryName(category) + " and they'll show up here every time you train it." : "Choosing Push, Pull, Legs or your own day lists its exercises here. You can also add any exercise directly."}</Empty></section>}
      {shown.map((exercise) => <ExerciseCard key={exercise.id + date} exercise={exercise} date={date} unit={state.unit}
        sets={sets.filter((s) => s.exerciseId === exercise.id)} stats={allStats[exercise.id]}
        categoryName={exercise.categoryId !== category ? categoryName(exercise.categoryId) : null}
        dispatch={dispatch} notify={notify} onOpen={() => onOpenExercise(exercise.id)} onDeleteSet={(set) => onDeleteSet(set, date, exercise.name)} />)}
      {shown.length > 0 && <button className="button full" onClick={onAddExercise}><Plus size={18} />Add another exercise</button>}
    </div>
  </div>;
}

/** Sheet to pick an exercise for the current workout or create a new one. */
function PickExercise({ state, defaultCategory, onPick, onClose }) {
  const [name, setName] = useState("");
  const [categoryId, setCategoryId] = useState(defaultCategory ?? state.categories[0]?.id ?? "");
  const query = name.trim().toLowerCase();
  const matches = state.exercises.filter((e) => !query || e.name.toLowerCase().includes(query));
  const exact = state.exercises.find((e) => sameName(e.name, name));
  const groups = [...state.categories, { id: null, name: "Uncategorized" }]
    .map((c) => ({ ...c, items: matches.filter((e) => e.categoryId === c.id) }))
    .filter((g) => g.items.length);
  const create = (e) => {
    e.preventDefault();
    if (!name.trim()) return;
    if (exact) { onPick(exact.id, false); return; }
    onPick({ id: generateId(), name: name.trim(), categoryId: categoryId || null }, true);
  };
  return <Sheet title="Add exercise" onClose={onClose}><div className="form">
    <form className="form" onSubmit={create} style={{ gap: 12 }}>
      <label>Search or create<input autoFocus value={name} maxLength={120} onChange={(e) => setName(e.target.value)} placeholder="e.g. Lateral Raise" /></label>
      {name.trim() && !exact && <div className="fields"><label>Day category<select value={categoryId ?? ""} onChange={(e) => setCategoryId(e.target.value)}>{state.categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}<option value="">Uncategorized</option></select></label><button className="button primary" type="submit" style={{ alignSelf: "end" }}><Plus size={18} />Create “{name.trim().slice(0, 24)}”</button></div>}
    </form>
    {groups.length ? <div className="card">{groups.map((g) => <div key={g.id ?? "none"}><p className="eyebrow" style={{ padding: "14px 20px 4px" }}>{g.name}</p>{g.items.map((e) => <button key={e.id} className="list-button item-row" onClick={() => onPick(e.id, false)}><span className="grow item-name">{e.name}</span><Plus size={18} /></button>)}</div>)}</div>
      : <p className="note">No exercises match. Create it above.</p>}
  </div></Sheet>;
}

/** Notes, records and progress for one exercise. */
function ExerciseDetail({ state, exercise, stats, dispatch, notify, onClose, onDelete }) {
  const unit = state.unit;
  const [notes, setNotes] = useState(exercise.notes);
  const [name, setName] = useState(exercise.name);
  const [editing, setEditing] = useState(false);
  const dirty = notes !== exercise.notes;
  const saveNotes = () => { dispatch({ type: "UPDATE_EXERCISE", payload: { id: exercise.id, notes } }); notify("Notes saved."); };
  const saveDetails = (e) => {
    e.preventDefault();
    if (!name.trim()) return;
    if (state.exercises.some((x) => x.id !== exercise.id && sameName(x.name, name))) { notify("Another exercise already has that name."); return; }
    dispatch({ type: "UPDATE_EXERCISE", payload: { id: exercise.id, name: name.trim().slice(0, 120) } });
    setEditing(false);
  };
  const points = stats.sessions.filter((s) => s.e1rm > 0).slice(-30);
  const values = points.map((p) => p.e1rm);
  const low = Math.min(...values) * .97, high = Math.max(...values) * 1.03 || 1;
  const coords = values.map((v, i) => [points.length === 1 ? 220 : 30 + i / (points.length - 1) * 380, 160 - (v - low) / Math.max(1e-9, high - low) * 125]);
  return <Sheet title={exercise.name} onClose={() => { if (dirty) saveNotes(); onClose(); }}><div className="form">
    {editing ? <form className="form" onSubmit={saveDetails} style={{ gap: 12 }}><label>Name<input value={name} maxLength={120} onChange={(e) => setName(e.target.value)} /></label><div className="fields"><button className="button primary" type="submit"><Check size={18} />Save name</button><button className="button" type="button" onClick={() => { setName(exercise.name); setEditing(false); }}>Cancel</button></div></form>
      : <div className="row between wrap"><label className="grow" style={{ minWidth: 180 }}>Day category<select value={exercise.categoryId ?? ""} onChange={(e) => dispatch({ type: "UPDATE_EXERCISE", payload: { id: exercise.id, categoryId: e.target.value || null } })}>{state.categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}<option value="">Uncategorized</option></select></label><button className="icon" style={{ alignSelf: "end" }} aria-label="Rename exercise" onClick={() => setEditing(true)}><Pencil size={17} /></button></div>}
    <section>
      <div className="stats three">
        <div className="stat"><small>{stats.e1rm?.reps === 1 ? "Best 1RM" : "Est. 1RM"}</small><strong>{stats.e1rm ? number(stats.e1rm.value) : "—"}</strong><small>{stats.e1rm ? (stats.e1rm.reps === 1 ? "actual single" : "from " + formatSet(stats.e1rm.weight, stats.e1rm.reps, unit)) : unit}</small></div>
        <div className="stat"><small>Heaviest</small><strong>{stats.heaviest ? (stats.heaviest.weight > 0 ? number(stats.heaviest.weight) : "BW") : "—"}</strong><small>{stats.heaviest ? (stats.heaviest.weight > 0 ? unit + " × " + stats.heaviest.reps : "") : unit}</small></div>
        <div className="stat"><small>Most reps</small><strong>{stats.mostReps ? stats.mostReps.reps : "—"}</strong><small>{stats.mostReps ? "at " + weightText(stats.mostReps.weight, unit) : "reps"}</small></div>
      </div>
      {stats.e1rm && <p className="note" style={{ marginTop: 10 }}>1RM is estimated with the Epley formula from sets of {MAX_E1RM_REPS} reps or fewer; an actual single counts as itself.</p>}
    </section>
    <label>Notes<textarea rows={5} maxLength={20000} value={notes} onChange={(e) => setNotes(e.target.value)} onBlur={() => { if (dirty) saveNotes(); }} placeholder="Cues, setup, seat height, grip, pain to watch for…" /></label>
    {points.length > 1 && <section><h3>Estimated 1RM over time</h3><div className="chart"><svg viewBox="0 0 440 200" role="img" aria-label={"Estimated 1RM across " + points.length + " sessions, from " + number(values[0]) + " to " + number(values[values.length - 1]) + " " + unit + "."}>{[40, 100, 160].map((y) => <line key={y} x1="30" x2="410" y1={y} y2={y} stroke="var(--line)" strokeDasharray="3 5" />)}<text x="30" y="22" fontSize="17" fill="var(--muted)">High {number(Math.max(...values))} {unit}</text><text x="30" y="192" fontSize="17" fill="var(--muted)">Low {number(Math.min(...values))} {unit}</text><polyline points={coords.map((p) => p.join(",")).join(" ")} fill="none" stroke="var(--green)" strokeWidth="3" strokeLinejoin="round" strokeLinecap="round" />{coords.map(([x, y], i) => <circle key={points[i].date} cx={x} cy={y} r="4" fill="var(--surface)" stroke="var(--green)" strokeWidth="2"><title>{formatDate(points[i].date)}: {number(values[i])} {unit}</title></circle>)}</svg></div><div className="row between note"><span>{formatDate(points[0].date, "short")}</span><span>{formatDate(points[points.length - 1].date, "short")}</span></div></section>}
    {stats.repRecords.length > 0 && <section><h3 style={{ marginBottom: 10 }}>Best reps at each weight</h3><table className="table"><thead><tr><th>Weight</th><th>Best reps</th><th>Date</th></tr></thead><tbody>{stats.repRecords.map((r) => <tr key={r.weight}><td>{weightText(r.weight, unit)}</td><td><strong>{r.reps}</strong></td><td className="muted">{formatDate(r.date, "short")}</td></tr>)}</tbody></table></section>}
    {stats.sessions.length > 0 && <section><h3 style={{ marginBottom: 6 }}>Recent sessions</h3>{[...stats.sessions].reverse().slice(0, 8).map((s) => <div key={s.date} style={{ marginTop: 12 }}><p className="eyebrow" style={{ marginBottom: 4 }}>{formatDate(s.date)}</p><SetRows sets={s.sets} unit={unit} prs={stats.prs} /></div>)}</section>}
    {!stats.count && <p className="note">No sets logged yet. Records appear here after your first set.</p>}
    <button className="button danger full" onClick={onDelete}><Trash2 size={17} />Delete exercise</button>
  </div></Sheet>;
}

function ExercisesScreen({ state, allStats, dispatch, notify, onOpen, onNew, onDeleteCategory }) {
  const [newCategory, setNewCategory] = useState("");
  const [renaming, setRenaming] = useState(null);
  const addCategory = (e) => {
    e.preventDefault();
    const name = newCategory.trim();
    if (!name) return;
    if (state.categories.some((c) => sameName(c.name, name))) { notify(name + " already exists."); return; }
    dispatch({ type: "ADD_CATEGORY", payload: { id: generateId(), name } });
    setNewCategory("");
    notify(name + " added.");
  };
  const rename = (e) => {
    e.preventDefault();
    if (!renaming.name.trim()) return;
    dispatch({ type: "RENAME_CATEGORY", payload: renaming });
    setRenaming(null);
  };
  const groups = [...state.categories, { id: null, name: "Uncategorized" }]
    .map((c) => ({ ...c, items: state.exercises.filter((e) => e.categoryId === c.id).sort((a, b) => a.name.localeCompare(b.name)) }))
    .filter((g) => g.id !== null || g.items.length);
  return <div className="columns">
    <div className="stack sticky">
      <section className="card pad">
        <div className="section-head"><h2>Day categories</h2></div>
        <p className="note" style={{ marginBottom: 16 }}>Group exercises by the kind of day you train them, like Push, Pull and Legs or Upper and Lower.</p>
        {state.categories.length > 0 && <div className="card" style={{ marginBottom: 16 }}>{state.categories.map((c) => <div className="item-row" key={c.id}>
          {renaming?.id === c.id ? <form className="row grow" onSubmit={rename}><input autoFocus value={renaming.name} maxLength={40} onChange={(e) => setRenaming({ ...renaming, name: e.target.value })} aria-label={"Rename " + c.name} /><button className="icon" type="submit" aria-label="Save name"><Check size={17} /></button></form>
            : <><div className="grow"><div className="item-name">{c.name}</div><small>{plural(state.exercises.filter((e) => e.categoryId === c.id).length, "exercise")}</small></div><button className="icon" aria-label={"Rename " + c.name} onClick={() => setRenaming({ id: c.id, name: c.name })}><Pencil size={16} /></button><button className="icon" aria-label={"Delete " + c.name} onClick={() => onDeleteCategory(c)}><Trash2 size={16} /></button></>}
        </div>)}</div>}
        <form className="row" onSubmit={addCategory}><input value={newCategory} maxLength={40} onChange={(e) => setNewCategory(e.target.value)} placeholder="New day, e.g. Upper" aria-label="New day category" /><button className="button soft" type="submit"><Plus size={18} />Add</button></form>
      </section>
    </div>
    <div className="stack">
      {groups.map((g) => <section className="card" key={g.id ?? "none"}>
        <div className="pad row between" style={{ paddingBottom: 12 }}><h2>{g.name}</h2><small>{plural(g.items.length, "exercise")}</small></div>
        {g.items.length ? g.items.map((e) => {
          const stats = allStats[e.id];
          return <button key={e.id} className="list-button item-row" onClick={() => onOpen(e.id)}>
            <div className="grow"><div className="item-name">{e.name}</div><div className="ex-meta"><RecordBadges stats={stats} unit={state.unit} />{e.notes && <span className="badge"><NotebookPen size={12} />Notes</span>}</div></div>
            <ChevronRight size={18} />
          </button>;
        }) : <p className="note pad" style={{ paddingTop: 0 }}>No exercises yet.</p>}
        <div className="history-actions" style={{ borderTop: "1px solid var(--line)" }}><button className="text-button row" onClick={() => onNew(g.id)}><Plus size={18} />Add exercise</button></div>
      </section>)}
    </div>
  </div>;
}

function HistoryScreen({ state, allStats, onOpenDay, onDeleteWorkout }) {
  const [filter, setFilter] = useState("all");
  const [expanded, setExpanded] = useState(null);
  const logged = state.workouts.filter((w) => w.sets.length || w.note);
  const days = logged.filter((w) => filter === "all" || w.categoryId === filter);
  const since = (n) => shiftDate(getLocalDateString(), -n + 1);
  const last7 = logged.filter((w) => w.date >= since(7)).length, last30 = logged.filter((w) => w.date >= since(30));
  const name = (id) => state.exercises.find((e) => e.id === id)?.name ?? "Exercise";
  const categoryName = (id) => state.categories.find((c) => c.id === id)?.name;
  // Workouts per week for the last 12 weeks.
  const weeks = Array.from({ length: 12 }, (_, i) => { const end = shiftDate(getLocalDateString(), -7 * (11 - i)); const start = shiftDate(end, -6); return { start, count: logged.filter((w) => w.date >= start && w.date <= end).length }; });
  const max = Math.max(1, ...weeks.map((w) => w.count));
  return <div className="columns">
    <div className="stack sticky"><section className="card pad">
      <div className="section-head"><h2>Consistency</h2></div>
      <div className="stats"><div className="stat"><small>Last 7 days</small><strong>{last7}</strong><small>{last7 === 1 ? "workout" : "workouts"}</small></div><div className="stat"><small>Last 30 days</small><strong>{last30.length}</strong><small>{last30.length === 1 ? "workout" : "workouts"}</small></div></div>
      <div className="bars" role="img" aria-label={"Workouts per week for the last 12 weeks: " + weeks.map((w) => w.count).join(", ") + "."}>{weeks.map((w) => <div className="bar" key={w.start} title={"Week of " + formatDate(w.start, "short") + ": " + plural(w.count, "workout")}><span style={{ height: Math.max(3, w.count / max * 80) + "px", opacity: w.count ? 1 : .35 }} /><small>{Number(w.start.slice(8))}</small></div>)}</div>
      <p className="note">Workouts per week; labels are each week's start date.</p>
      {state.categories.length > 0 && last30.length > 0 && <div className="ex-meta" style={{ marginTop: 14 }}>{state.categories.map((c) => <span className="badge cat" key={c.id}>{c.name} · {last30.filter((w) => w.categoryId === c.id).length}</span>)}</div>}
    </section></div>
    <div className="stack">
      {state.categories.length > 0 && <div className="chips"><button aria-pressed={filter === "all"} onClick={() => setFilter("all")}>All</button>{state.categories.map((c) => <button key={c.id} aria-pressed={filter === c.id} onClick={() => setFilter(c.id)}>{c.name}</button>)}</div>}
      {days.length === 0 ? <section className="card"><Empty icon={History} title={logged.length ? "No workouts for this day" : "No workouts yet"} action="Log a workout" onAction={() => onOpenDay(getLocalDateString())}>Logged workouts appear here, newest first.</Empty></section>
        : <section className="card">{days.map((w) => {
          const open = expanded === w.date;
          const ids = [...new Set(w.sets.map((s) => s.exerciseId))];
          const prCount = w.sets.filter((s) => allStats[s.exerciseId]?.prs.has(s.id)).length;
          return <div className="history-day" key={w.date}>
            <button className="history-heading" aria-expanded={open} onClick={() => setExpanded(open ? null : w.date)}><div className="grow"><h3>{formatDate(w.date)}</h3><small>{plural(ids.length, "exercise")} · {plural(w.sets.length, "set")}</small>{categoryName(w.categoryId) && <span className="badge cat">{categoryName(w.categoryId)}</span>}{prCount > 0 && <span className="badge pr"><Trophy size={12} />{plural(prCount, "PR")}</span>}</div>{open ? <ChevronUp size={19} /> : <ChevronDown size={19} />}</button>
            {open && <div className="history-details">
              {w.note && <p className="notes-text" style={{ margin: "14px 20px 0" }}>{w.note}</p>}
              {ids.map((id) => <div key={id} style={{ padding: "14px 20px 0" }}><h3>{name(id)}</h3><SetRows sets={w.sets.filter((s) => s.exerciseId === id)} unit={state.unit} prs={allStats[id]?.prs} /></div>)}
              <div className="history-actions"><button className="text-button row" onClick={() => onOpenDay(w.date)}><Pencil size={16} />Edit workout</button><button className="icon" aria-label={"Delete workout on " + formatDate(w.date)} onClick={() => onDeleteWorkout(w)}><Trash2 size={17} /></button></div>
            </div>}
          </div>;
        })}</section>}
    </div>
  </div>;
}

function PasteLog({ state, dispatch, onClose, notify }) {
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const area = useRef(null);
  const today = getLocalDateString();
  let preview = null, previewError = "";
  if (text.trim()) {
    try { preview = parsePatch(text, state.unit, today); } catch (e) { previewError = e.message; }
  }
  const duplicate = preview?.id && state.appliedPatches.includes(preview.id);
  const setCount = preview ? preview.workouts.reduce((n, w) => n + w.exercises.reduce((m, e) => m + e.sets.length, 0), 0) : 0;
  const pasteClipboard = async () => {
    try {
      const clip = await navigator.clipboard.readText();
      if (!clip.trim()) { setError("Your clipboard is empty."); return; }
      setText(clip); setError("");
    } catch {
      setError("Clipboard access was blocked. Long-press the box and choose Paste.");
      area.current?.focus();
    }
  };
  const apply = () => {
    if (!preview || duplicate) return;
    dispatch({ type: "APPLY_PATCH", payload: preview });
    notify(setCount ? "Logged " + plural(setCount, "set") + "." : "Workout updated.");
    onClose();
  };
  return <Sheet title="Paste from Claude" onClose={onClose}><div className="form">
    <p className="note">Paste the JSON block Claude gave you. You'll see what will be logged before anything is saved. New exercises and day categories are created automatically.</p>
    <button type="button" className="button soft full" onClick={pasteClipboard}><ClipboardPaste size={18} />Paste from clipboard</button>
    <label>JSON<textarea className="code" ref={area} rows={6} spellCheck={false} autoCapitalize="off" autoCorrect="off" value={text} onChange={(e) => { setText(e.target.value); setError(""); }} placeholder={'{ "workoutTracker": "patch", "workouts": [ … ] }'} aria-invalid={previewError ? "true" : undefined} /></label>
    {(error || previewError) && <p className="error" role="alert">{error || previewError}</p>}
    {duplicate && <p className="error" role="alert">This patch was already logged, so it won't be added again.</p>}
    {preview && !duplicate && <div className="card">{preview.workouts.map((w, i) => <div key={i} className="pad" style={{ borderTop: i ? "1px solid var(--line)" : 0 }}>
      <div className="row between wrap"><h3>{w.date === today ? "Today" : formatDate(w.date)}</h3>{w.category && <span className="badge cat">{w.category}{state.categories.some((c) => sameName(c.name, w.category)) ? "" : " · new"}</span>}</div>
      {w.note && <p className="note" style={{ marginTop: 6 }}>{w.note}</p>}
      {w.exercises.map((e, j) => <div key={j} style={{ marginTop: 10 }}><div className="row between"><strong>{e.name}</strong>{!state.exercises.some((x) => sameName(x.name, e.name)) && <span className="badge">New exercise</span>}</div><small>{e.sets.map((s) => formatSet(s.weight, s.reps, preview.unit)).join(" · ") || "No sets"}</small>{e.notes && <p className="note">Note: {e.notes}</p>}</div>)}
    </div>)}</div>}
    <button className="button primary full" disabled={!preview || duplicate} onClick={apply}><Check size={19} />{setCount ? "Log " + plural(setCount, "set") : "Apply"}</button>
  </div></Sheet>;
}

function backupFileName() {
  return "workouttracker-backup-" + getLocalDateString() + ".json";
}

function SettingsScreen({ state, dispatch, onReset, onImport, notify }) {
  const fileInput = useRef(null);
  const exportData = () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify({ app: "workoutTracker", version: 1, exportedAt: new Date().toISOString(), data: state }, null, 2)], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url; link.download = backupFileName();
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    notify("Backup downloaded.");
  };
  const importData = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      const data = normalizeState(parsed?.app === "workoutTracker" ? parsed.data : parsed);
      if (!data || (!data.workouts.length && !data.exercises.length)) throw new Error("empty");
      onImport(data);
    } catch {
      notify("That file isn't a WorkoutTracker backup.");
    }
  };
  return <div className="columns">
    <div className="stack">
      <section className="card pad"><h2 style={{ marginBottom: 8 }}>Weight unit</h2><p className="note" style={{ marginBottom: 18 }}>Sets keep the unit they were logged in; records and totals are converted for display.</p><div className="segments">{["lbs", "kg"].map((u) => <button key={u} aria-pressed={state.unit === u} onClick={() => dispatch({ type: "SET_UNIT", payload: u })}>{u === "lbs" ? "Pounds · lbs" : "Kilograms · kg"}</button>)}</div></section>
      <section className="card pad"><h2 style={{ marginBottom: 18 }}>Appearance</h2><div className="segments">{[["light", Sun], ["dark", Moon]].map(([theme, Icon]) => <button key={theme} className="row" aria-pressed={state.theme === theme} onClick={() => dispatch({ type: "SET_THEME", payload: theme })}><Icon size={18} />{theme === "light" ? "Light" : "Dark"}</button>)}</div></section>
    </div>
    <div className="stack">
      <section className="card pad"><div className="section-head"><h2>Backup</h2></div><p className="note">Your workouts, exercises and notes are saved in this browser. Clearing browser data removes them, so download a backup now and then. Restore it here or on another device.</p><div className="fields" style={{ marginTop: 18 }}><button className="button soft" onClick={exportData}>Download backup</button><button className="button" onClick={() => fileInput.current?.click()}>Restore backup</button></div><input ref={fileInput} type="file" accept="application/json,.json" hidden onChange={importData} /></section>
      <section className="card pad"><h2>Reset</h2><p className="note" style={{ margin: "10px 0 18px" }}>Erase all workouts, exercises, notes and preferences, and restore the default Push/Pull/Legs setup.</p><button className="button danger full" onClick={onReset}><RotateCcw size={17} />Reset all data</button></section>
    </div>
  </div>;
}

function Confirm({ title, description, confirm, onConfirm, onClose, keep = "Cancel" }) {
  return <Sheet title={title} onClose={onClose}><div className="form"><p className="muted">{description}</p><button className="button danger" onClick={onConfirm}>{confirm}</button><button className="button full" onClick={onClose}>{keep}</button></div></Sheet>;
}

export default function WorkoutTracker() {
  const [state, dispatch] = useReducer(reducer, null, () => loadState() || DEFAULT_STATE);
  const [today, setToday] = useState(getLocalDateString);
  const [date, setDate] = useState(today);
  const [tab, setTab] = useState("workout");
  const [sheet, setSheet] = useState(null);
  const [toast, setToast] = useState("");
  const [storageError, setStorageError] = useState(false);
  const timer = useRef(null);
  const notify = (message) => { clearTimeout(timer.current); setToast(message); timer.current = setTimeout(() => setToast(""), 4000); };
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    saveState(state);
    try { setStorageError(localStorage.getItem(STORAGE_KEY) !== JSON.stringify(state)); } catch { setStorageError(true); }
  }, [state]);
  useEffect(() => {
    document.documentElement.classList.toggle("dark", state.theme === "dark");
  }, [state.theme]);
  // Roll the workout date forward at midnight if it was showing today.
  useEffect(() => {
    const check = () => {
      const now = getLocalDateString();
      if (now !== today) { setDate((d) => (d === today ? now : d)); setToday(now); }
    };
    const visible = () => { if (document.visibilityState === "visible") check(); };
    const interval = setInterval(check, DATE_CHECK_INTERVAL_MS);
    window.addEventListener("focus", check);
    document.addEventListener("visibilitychange", visible);
    return () => { clearInterval(interval); window.removeEventListener("focus", check); document.removeEventListener("visibilitychange", visible); };
  }, [today]);
  useEffect(() => {
    const sync = (e) => { if (e.key === STORAGE_KEY && e.newValue) { const saved = loadState(); if (saved) dispatch({ type: "INIT", payload: saved }); } };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, []);
  const allStats = useMemo(() => Object.fromEntries(state.exercises.map((e) => [e.id, exerciseStats(state.workouts, e.id, state.unit)])), [state.exercises, state.workouts, state.unit]);
  const workoutCategory = state.workouts.find((w) => w.date === date)?.categoryId ?? null;
  const close = () => setSheet(null);
  const openDay = (d) => { setDate(d); setTab("workout"); window.scrollTo({ top: 0, behavior: "instant" }); };
  // Exercises picked for this date without a set yet; they are saved once a set is logged.
  const [pinned, setPinned] = useState([]);
  useEffect(() => setPinned([]), [date]);
  const pickExercise = (picked, isNew) => {
    if (isNew) dispatch({ type: "ADD_EXERCISE", payload: picked });
    const id = isNew ? picked.id : picked;
    const exercise = isNew ? picked : state.exercises.find((e) => e.id === id);
    if (sheet.mode === "workout") {
      setPinned((p) => [...new Set([...p, id])]);
      notify(exercise.name + (isNew ? " created and added." : " added."));
      close();
    } else {
      if (isNew) notify(exercise.name + " created.");
      setSheet({ kind: "exercise", id });
    }
  };
  const deleteSet = (set, d, exerciseName) => setSheet({ kind: "confirm", title: "Delete set?", description: "Remove " + formatSet(round1(toUnit(set, state.unit)), set.reps, state.unit) + " of " + exerciseName + ". Records are recalculated from the remaining sets.", confirm: "Delete set", action: { type: "DELETE_SET", payload: { date: d, id: set.id } }, done: "Set deleted." });
  const tabs = [["workout", Dumbbell, "Workout"], ["history", History, "History"], ["exercises", Layers, "Exercises"], ["settings", Settings, "Settings"]];
  const title = tabs.find(([key]) => key === tab)[2];
  const detail = sheet?.kind === "exercise" ? state.exercises.find((e) => e.id === sheet.id) : null;
  return <div className="wt" data-theme={state.theme}>
    <style>{UI_CSS}</style>
    <div inert={sheet ? "" : undefined}>
      <div className="shell"><div className="brand"><Dumbbell size={20} />workout<span style={{ fontWeight: 400, color: "var(--muted)", marginLeft: -5 }}>tracker</span></div>
        <header className="header"><div>{tab === "workout" && <p className="eyebrow">{date === today ? "Today · " : ""}{formatDate(date)}</p>}<h1>{title}</h1></div>
          {tab === "workout" && <div className="header-actions"><button className="icon" aria-label="Paste from Claude" title="Paste from Claude" onClick={() => setSheet({ kind: "paste" })}><ClipboardPaste size={20} /></button><button className="button primary" aria-label="Add exercise" onClick={() => setSheet({ kind: "pick", mode: "workout" })}><Plus size={20} /><span>Add exercise</span></button></div>}
          {tab === "exercises" && <div className="header-actions"><button className="button primary" aria-label="New exercise" onClick={() => setSheet({ kind: "pick", mode: "library" })}><Plus size={20} /><span>New exercise</span></button></div>}
        </header>
        {storageError && <p className="error card pad" role="alert" style={{ marginBottom: 20 }}>Changes could not be saved in this browser. Keep this page open and free up browser storage before leaving.</p>}
        <main id="main-content">
          {tab === "workout" && <WorkoutScreen state={state} date={date} setDate={setDate} today={today} allStats={allStats} pinned={pinned} dispatch={dispatch} notify={notify}
            onAddExercise={() => setSheet({ kind: "pick", mode: "workout" })} onOpenExercise={(id) => setSheet({ kind: "exercise", id })} onDeleteSet={deleteSet} />}
          {tab === "history" && <HistoryScreen state={state} allStats={allStats} onOpenDay={openDay}
            onDeleteWorkout={(w) => setSheet({ kind: "confirm", title: "Delete workout?", description: "Remove the " + formatDate(w.date) + " workout: " + plural(w.sets.length, "set") + (w.note ? " and its note" : "") + ". Records are recalculated.", confirm: "Delete workout", action: { type: "DELETE_WORKOUT", payload: w.date }, done: "Workout deleted." })} />}
          {tab === "exercises" && <ExercisesScreen state={state} allStats={allStats} dispatch={dispatch} notify={notify} onOpen={(id) => setSheet({ kind: "exercise", id })} onNew={(categoryId) => setSheet({ kind: "pick", mode: "library", categoryId })}
            onDeleteCategory={(c) => setSheet({ kind: "confirm", title: "Delete " + c.name + "?", description: "Its exercises move to Uncategorized and past workouts lose the label. No sets or notes are deleted.", confirm: "Delete category", action: { type: "DELETE_CATEGORY", payload: c.id }, done: c.name + " deleted." })} />}
          {tab === "settings" && <SettingsScreen state={state} dispatch={dispatch} notify={notify} onReset={() => setSheet({ kind: "confirm", title: "Reset all data?", description: "This permanently erases all workouts, exercises, notes and preferences on this device. This cannot be undone.", confirm: "Erase all data", keep: "Keep my data", action: { type: "RESET_ALL" }, done: "All data reset." })} onImport={(data) => setSheet({ kind: "import", data })} />}
        </main>
      </div>
      <nav className="nav" aria-label="Main navigation">{tabs.map(([key, Icon, label]) => <button key={key} aria-current={tab === key ? "page" : undefined} onClick={() => { setTab(key); window.scrollTo({ top: 0, behavior: "instant" }); }}><Icon size={22} strokeWidth={tab === key ? 2.2 : 1.7} />{label}</button>)}</nav>
    </div>
    {sheet?.kind === "pick" && <PickExercise state={state} defaultCategory={sheet.mode === "workout" ? workoutCategory : sheet.categoryId} onPick={pickExercise} onClose={close} />}
    {detail && <ExerciseDetail key={detail.id} state={state} exercise={detail} stats={allStats[detail.id]} dispatch={dispatch} notify={notify} onClose={close}
      onDelete={() => setSheet({ kind: "confirm", title: "Delete " + detail.name + "?", description: "This removes the exercise, its notes and " + plural(allStats[detail.id].count, "logged set") + ". This cannot be undone.", confirm: "Delete exercise", action: { type: "DELETE_EXERCISE", payload: detail.id }, done: detail.name + " deleted." })} />}
    {sheet?.kind === "paste" && <PasteLog state={state} dispatch={dispatch} onClose={close} notify={notify} />}
    {sheet?.kind === "confirm" && <Confirm {...sheet} onClose={close} onConfirm={() => { dispatch(sheet.action); notify(sheet.done); close(); }} />}
    {sheet?.kind === "import" && <Sheet title="Restore backup?" onClose={close}><div className="form"><p className="muted">This replaces everything on this device with the backup: {plural(sheet.data.workouts.length, "workout")} and {plural(sheet.data.exercises.length, "exercise")}. Download a backup of your current data first if you might want it.</p><button className="button primary" onClick={() => { dispatch({ type: "INIT", payload: sheet.data }); notify("Backup restored."); close(); }}>Replace with backup</button><button className="button full" onClick={close}>Cancel</button></div></Sheet>}
    <div role="status" aria-live="polite" aria-atomic="true">{toast && <div className="toast">{toast}</div>}</div>
    <Analytics />
  </div>;
}
