# WorkoutTracker

A clean, mobile-first workout log built with React. Log sets, keep notes on each exercise, and watch your personal records update as you train. No accounts, no servers — your data stays in your browser.

![React](https://img.shields.io/badge/React-18-61DAFB?logo=react&logoColor=white)
![Vite](https://img.shields.io/badge/Vite-6-646CFF?logo=vite&logoColor=white)
![Tailwind CSS](https://img.shields.io/badge/Tailwind_CSS-3-06B6D4?logo=tailwindcss&logoColor=white)
![Deployed on Vercel](https://img.shields.io/badge/Vercel-Deployed-black?logo=vercel&logoColor=white)

---

## Features

**Workout Logging**
- Pick the day (Push, Pull, Legs, or your own) and its exercises are listed, ready to log
- Log weight × reps per set; the form remembers your last set for quick repeats
- Weight 0 logs a bodyweight set
- Add any other exercise to a session, or create a new one on the spot
- Step back through previous days to backfill or fix a workout
- Per-workout notes, plus exercise, set and volume totals

**Day Categories**
- Group exercises by the kind of day you train them
- Add, rename and delete categories; deleting one never deletes sets or notes

**Exercise Notes**
- Each exercise keeps its own notes (cues, setup, seat height, grip…)
- Notes show on the exercise card while you log, so they're in front of you mid-workout

**Personal Records**
- Running best 1RM per exercise: an actual single counts as itself; otherwise it's estimated with the Epley formula from sets of 12 reps or fewer
- Best reps at every weight you've lifted, with the date
- Heaviest set and most reps
- Sets that beat a record are badged **1RM PR** or **Rep PR**, and you get a toast the moment it happens
- Records are recomputed from the log, so deleting or backfilling a set keeps them correct
- Estimated 1RM chart over time and recent sessions per exercise

**History**
- Workouts per week for the last 12 weeks, 7- and 30-day counts, and per-category counts
- Filter by day category; expand any workout to see every set

**Log from Claude (JSON patch)**
- Tell Claude what you did; it replies with a JSON block
- Tap the clipboard icon on Workout → **Paste from clipboard**, review, then **Log**
- Unknown exercises and categories are created; a pasted category labels a new or unlabeled day but never relabels one you set
- Each patch's `id` is applied only once, so pasting twice won't double-log

```json
{
  "workoutTracker": "patch",
  "id": "2026-10-25-push",
  "unit": "lbs",
  "workouts": [{
    "date": "2026-10-25",
    "category": "Push",
    "note": "Felt strong",
    "exercises": [
      { "name": "Bench Press", "notes": "Pause the first rep", "sets": [{ "weight": 185, "reps": 5 }, { "weight": 185, "reps": 5 }] }
    ]
  }]
}
```
`id`, `unit` (defaults to your setting), `date` (defaults to today), `category`, `note` and exercise `notes` are optional. A single workout object or a bare array of workouts also works. Exercise notes are appended with the date.

**Settings**
- Pounds or kilograms; sets keep the unit they were logged in and are converted for display
- Dark / light theme toggle
- Download a JSON backup and restore it later or on another device
- Full data reset option

**Privacy-First**
- 100% client-side — all data lives in `localStorage`
- No accounts and no backend; the only network use is anonymous Vercel page-view analytics
- Open the app in several tabs safely: each tab picks up the others' changes

## Tech Stack

| Layer      | Technology                         |
|------------|------------------------------------|
| Framework  | React 18                           |
| Bundler    | Vite 6                             |
| Styling    | Tailwind CSS 3 + scoped CSS        |
| Charts     | Hand-rolled SVG                    |
| Icons      | Lucide React                       |
| Hosting    | Vercel                             |
| Analytics  | Vercel Analytics (anonymous only)  |

## Getting Started

```bash
# Clone the repo
git clone https://github.com/LukeSheely/workout-tracker.git
cd workout-tracker

# Install dependencies
npm install

# Start dev server
npm run dev
```

Open [http://localhost:5173](http://localhost:5173) in your browser.

### Build for Production

```bash
npm run build
npm run preview
```

## Project Structure

```
├── WorkoutTracker.jsx    # All app logic in a single component file
├── index.html            # Entry HTML
├── src/
│   ├── main.jsx          # React root mount
│   └── index.css         # Tailwind imports + base styles
├── vite.config.js
├── tailwind.config.js
├── postcss.config.js
└── package.json
```

The entire app lives in `WorkoutTracker.jsx` — reducer, records, components and all — mirroring [MacroTracker](https://github.com/LukeSheely/macro-tracker).

## License

MIT
