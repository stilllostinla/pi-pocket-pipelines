# Pi Pocket Pipelines

A visual, durable LLM workflow editor for [Pi Pocket](https://github.com/TannerMidd/pi-pocket), as a drop-in extension.

Drag nodes onto a canvas, connect them, and run: chained LLM calls, parallel scout agents, refines, branches, classifiers, fan-out maps, budgeted merges, shell commands, file reads/writes, fetches, human approvals, and nested pipelines — with every run checkpointed so a server restart resumes it instead of losing it.

![node types: Input, LLM call, Agent, Prompt, Shell, Code, Branch, Decision, Refine, Map, Merge, Write, Read, Fetch, Approval, Sub-pipeline, Output]

## Install

```sh
./install.sh            # copies into ${PI_POCKET_DIR:-~/.pi-pocket}/extensions
```

Then in Pi Pocket: **Menu → Extensions → Pipelines → turn on**, and refresh. A **Pipelines** button appears on the left rail.

## Use

- **Add a step** from the palette, drag it into place. Tap its right dot, then another step's left dot, to connect. Steps at the same depth with their inputs ready run **in parallel** (fan-out); a step with several inputs waits for all of them (fan-in).
- **Tap a step** to edit it in the *Edit step* panel: label, prompt, model, and per-step behavior.
- **Branch** steps output `true`/`false`; tap an edge leaving one to route *when true* / *when false*. The losing path is skipped, not failed.
- **Run**: pick a session (its model, folder, and spend limit apply), give the Input text, and Run. Runs survive restarts; stop lands at the next step boundary.
- A **Research scouts** template is built in: one brief → three parallel Agent scouts (sources / practice / critic) → join → synthesis.

### Node types

| Type | What it does |
|---|---|
| Input | The run's input text |
| LLM call | One model call (session model, or one you pick) |
| Agent | A real Pi sub-session with tools and its own transcript — open it from the run |
| Prompt | Template expansion, no model |
| Shell | A shell command in the run session's folder (runs on the server!) |
| Code | JavaScript in a sandbox: `input`, `upstream`, `outputs` globals; return a value. No tools/files/network |
| Branch | `contains` / `equals` / non-empty test → `true`/`false` |
| Decision | Classifier (Jev, Jev via OpenRouter, or OpenAI Decisions): Choice → category, Yes/No → true/false, Score → high/low, or `unsure` |
| Refine | Repeat an LLM call N rounds (or until output contains text), `{{prev}}`/`{{index}}` |
| Map | Run a sub-pipeline once per item (JSON array, lines, `file:path`, `folder:path` of .txt) with `{{item}}`/`{{index}}`; outputs a JSON array of `{item, output}` |
| Merge | Fan-in under a token budget: keep top briefs whole, summarize or drop the rest |
| Write | Write text to a path in the run folder; tracked in the run |
| Read | Output a run-folder file's text (first 100k chars) |
| Fetch | Fetch a public URL (SSRF-safe, no key); warns on thin JS-walled pages |
| Approval | Pauses and asks a person in the run's session; decline can fail the run or output `declined` |
| Sub-pipeline | Runs another saved pipeline (max 3 deep) |
| Output | Final text |

Templates: `{{input}}`, `{{upstream}}` (direct predecessors), `{{Node label}}`, `{{node-id}}`, `{{param:name}}` (run parameters). Map child inputs also get `{{item}}` and `{{index}}`. Edges can carry a `when` value to route by (category names, `true`/`false`, `high`/`low`, `unsure`, or anything a step outputs). An edge into an already-finished step loops back and re-runs it — with the edge's note appended — up to its re-run cap (default 3).
Most executable steps can **continue on error**: the step outputs nothing, the failure is noted in the run, and downstream steps still run — made for parallel scouts.

Pi can drive it too: `pipe_list`, `pipe_put` (graph JSON), `pipe_get`, `pipe_run`, `pipe_status`, `pipe_stop`.

## Decision steps (classifiers)

A Decision step sends the text you point it at to a decision model instead of a generative LLM. Three providers, one routing language:

| Provider | Endpoint | Models | Key |
|---|---|---|---|
| Jev (direct) | `POST https://api.typesafe.ai/v1/systemone` | `jev-latest` (default) | `TYPESAFE_API_KEY` |
| Jev via OpenRouter | `POST https://openrouter.ai/api/v1/systemone` | `typesafe/jev-1.14` (default) | `OPENROUTER_API_KEY` |
| OpenAI Decisions | `POST https://api.openai.com/v1/decisions` | `gpt-6-luna` (default) | `OPENAI_API_KEY` |

- **Choice** — categories as `name: when it applies` lines plus a question. Outputs the winning category name; route edges with `when` set to a category.
- **Yes / No** — a yes-no question + threshold (default 50%). Outputs `true`/`false`, routed like a Branch.
- **Score** — ordered levels (`label: when it applies`, lowest first) + a cut (default: the middle). Outputs `high`/`low`; the raw score is in the run log.
- **Unsure** — set a minimum confidence. Below it the step outputs `unsure`, which you route with an edge whose `when` is `unsure` (e.g. to a human Approval step).

### Credentials

Keys are resolved per provider in this order, at run time:

1. **Pipelines settings** — Menu → Extensions → Pipelines (three secret fields: Jev, OpenRouter, OpenAI).
2. **Secrets catalog** — Menu → Secrets, named `TYPESAFE_API_KEY` / `JEV_API_KEY`, `OPENROUTER_API_KEY` / `OPENROUTER`, `OPENAI_API_KEY` / `OPENAI`. The catalog keeps its rules: ask-gated secrets are refused (Decision steps run unattended — turn off “ask each use” for pipeline keys), folder limits and the owner-only rule apply.
3. **Server environment** — `TYPESAFE_API_KEY`, `OPENROUTER_API_KEY`, `OPENAI_API_KEY`.

Key values are used only in HTTPS `Authorization` headers. They are never stored in pipeline data, never logged, never shown — and each distinct value is additionally masked everywhere Pi and people read, so it cannot leak by accident. The editor only learns *whether* a key exists, and warns on a Decision step whose provider has none. Usage tokens are counted under `typesafe/*` / `openrouter/*` / `openai/*` in the run session's spend ledger (cost attached as $0 — check your provider console for actual spend).

Rule of thumb: **Branch** for exact rules you can write down, **Decision** for judgment calls in prose (tone, topic, spam, severity) where a keyword test would be brittle.

## Research runs: map, loop-back, merge, files

The research pattern — plan once, fan out per URL, score each, repair the dead ones, merge under a token budget:

- **Map** runs one saved pipeline per item. The list is a JSON array, one item per line, `file:path` (JSON or line-per-item), or `folder:path` (every `.txt`, sorted — your raw pages on disk, or a later run's seed). Each child is its own durable run with a fixed id (`{{item}}` and `{{index}}` available to its input), sequential at concurrency 1 (saves quota) or parallel up to 8. Output is a JSON array of `{item, output}`. Per-item failure fails the map unless the Map step says continue-on-error — then that item outputs `""` and the run notes it.
- **Loop-back** is any edge into an already-finished step: when the step's output matches the edge's `when`, the target and everything downstream of it re-run, with the edge's note appended to the target's upstream. Dead URL → route back to the scout with “this was a 404, find the correct URL” instead of dropping it. Re-run caps (default 3 per step, configurable) stop runaway loops.
- **Merge** keeps the fan-in under a token budget (default 50k): items with a numeric `score` rank first, the top N stay whole, the rest are summarized into one brief with the run's model (or dropped). Nothing is silently truncated — the run log says what was kept, summarized, or dropped.
- **Files** are first-class: Write drops text (raw pages, briefs, reports, topology) into the run folder, every file is tracked in the run (`pipe_status` lists path, bytes, authoring step), Read feeds files back in. Later runs load the same paths as seeds.
- **Params** (`{{param:name}}`, set per run in the editor or `pipe_run paramsJson`): depth, breadth, caps that change behavior without editing the graph. Child runs inherit them.

## Durability

Graphs and runs live in Pi Durable documents (`x.pipelines.*`); each run is a durable task that checkpoints after every batch of steps and memoizes finished steps, so a restart resumes mid-run without re-calling models or respawning agent sub-sessions (fixed request/run ids throughout).

## Scraping without keys

The **Fetch** step uses Pi Pocket's SSRF-safe fetcher: public URLs only, redirects checked, HTML stripped to text, no API key and no quota. It covers .gov, academic, and most blogs/forums. Pages that need JavaScript come back thin and are flagged in the run log instead of silently poisoning a brief — handle those with an Agent scout (Pi's browser) or route `when` onward. A Jina/Firecrawl provider can be added to the same step later if runs show systematic JS walls.

## Security

Shell steps run shell commands on the server, and Agent steps run Pi with its tools, both under the run session's folder and spend limit. Treat a saved pipeline like a script you would run yourself, and review pipelines from other people before running them.

## Development

The server module is TypeScript Pi Pocket loads as-is; the editor is a plain-JS browser module (no build step), written against Pocket's bundled Preact 11.

Tests (fake model, in-memory harness; jsdom for the editor):

```sh
node --experimental-strip-types tests/e2e.ts   # runner: fan-out/in, branch, decision x3 providers, refine, code, agents, continue-on-error, approval, sub-pipelines, map, loop-back, merge, files, params, secrets precedence+gating
cd tests && npm install && node ui.test.mjs    # editor: rename/edit/save, template shape (uses PI_POCKET_CODE, default /opt/pi-pocket)
```

Layout: `pipelines.ts` (server: routes, durable task, Pi tools), `pipelines/index.js` + `pipelines/style.css` (editor), `tests/`.

## License

MIT
