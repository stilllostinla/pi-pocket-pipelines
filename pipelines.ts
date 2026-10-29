/**
 * Pipelines: visually build durable LLM workflows and run them on Pi.
 * Adds a Pipelines page on the rail where you drag nodes (Input, LLM call, Agent, Prompt, Shell, Code, Branch, Loop,
 * Approval, Sub-pipeline, Output), connect them (fan-out, fan-in, conditional branches), save, and run. Runs are
 * durable: graphs and run state live in documents, and each run is a durable task that checkpoints after every batch
 * of nodes, so a server restart resumes it. LLM nodes call a model (the session's, or one the owner allows for
 * subagents); Agent nodes start a real Pi sub-session with its own tools and transcript; Approval nodes pause and
 * ask a person in the run's session; Code nodes run JavaScript in the codemode sandbox with no tools; Shell nodes
 * run shell commands in the run session's folder on this server — treat a saved pipeline like a script you would
 * run yourself. Pi can also list, create, run, and check pipelines with the pipe_* tools.
 *
 * Decision steps authenticate to classifier APIs with keys from Pipelines settings, the owner's Secrets catalog
 * (Menu → Secrets), or server environment variables, in that order. Catalog secrets keep their rules: ask-gated
 * secrets are refused (Decision steps run unattended), folder limits and the owner-only rule apply. Key values are
 * used only in HTTPS Authorization headers and are never stored, logged, or shown.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import {
    AssistantEntry,
    configure,
    defineDoc,
    defineExtension,
    defineTask,
    defineTool,
    UsageDoc,
} from "@earendil-works/pi-durable";
import type { Host, Web } from "./_pocket.d.ts";

/** Matches the pipelines extension by name, so Agent-node sub-sessions can be kept from running pipelines themselves. */
const PipelinesRef = defineExtension({ name: "pipelines" });

export const pocketApi = 2;

// ─── Stored shapes ───────────────────────────────────────────────────────────

type PipeNode = {
    id: string;
    type: string;
    x: number;
    y: number;
    config: Record<string, unknown>;
};
type PipeEdge = { id: string; from: string; to: string; when?: string; note?: string };
type PipeGraph = { nodes: PipeNode[]; edges: PipeEdge[] };
type PipeDef = { id: string; name: string; graph: PipeGraph; createdAt: number; updatedAt: number };
type RunLog = { at: number; node?: string; text: string };
type PipeRun = {
    id: string;
    pipelineId: string;
    name: string;
    graph: PipeGraph;
    input: string;
    conversationId: number;
    taskId?: number;
    status: "queued" | "running" | "done" | "failed" | "stopped";
    stopRequested?: boolean;
    outputs: Record<string, string>;
    skipped: string[];
    current: string[];
    steps: number;
    log: RunLog[];
    error?: string;
    /** Sub-sessions started by Agent nodes, by node id: shown in the editor, and openable there. */
    agentSessions?: Record<string, number>;
    /** Sub-pipeline nesting depth (0 for a run a person or Pi started directly). */
    depth?: number;
    parentRunId?: string;
    /** Nodes that failed but whose node said continue-on-error: output is empty, the run goes on. */
    failedNodes?: Record<string, string>;
    /** Run parameters (depth, breadth, …): templates read them as {{param:name}}. Child runs inherit them. */
    params?: Record<string, string>;
    /** Completions per node: loop-back edges re-run a node until its cap. */
    visits?: Record<string, number>;
    /** Repair notes delivered to a node by a loop-back edge, appended to its upstream once. */
    loopNotes?: Record<string, string>;
    /** Files written by this run: path (relative to the run folder), bytes, authoring node. */
    files?: { path: string; bytes: number; byNode: string; label: string; at: number }[];
    createdAt: number;
    startedAt?: number;
    endedAt?: number;
    by?: string;
};

const rebased = {
    checkpointWhen: (_value: unknown, _ops: unknown, info: { deltasSinceBase: number }) =>
        info.deltasSinceBase >= 64,
};

const DefsDoc = defineDoc<{ items: Record<string, PipeDef> }>({
    kind: "x.pipelines.defs",
    version: 1,
    ...rebased,
    scope: "session",
    initial: () => ({ items: {} }),
});

const RunsDoc = defineDoc<{ items: Record<string, PipeRun> }>({
    kind: "x.pipelines.runs",
    version: 1,
    ...rebased,
    scope: "session",
    initial: () => ({ items: {} }),
});

// ─── Graph helpers ───────────────────────────────────────────────────────────

const NODE_TYPES = ["input", "llm", "agent", "prompt", "bash", "code", "branch", "decision", "refine", "map", "merge", "write", "read", "fetch", "approval", "subpipe", "output"];
const MAX_NODES = 100;
const MAX_EDGES = 300;
const MAX_TEXT = 20_000;

function cleanText(value: unknown, max = MAX_TEXT): string {
    return typeof value === "string" ? value.slice(0, max) : "";
}

function cleanNumber(value: unknown, fallback: number, min: number, max: number): number {
    const n = typeof value === "number" && Number.isFinite(value) ? value : fallback;
    return Math.min(max, Math.max(min, Math.round(n)));
}

/** Check a graph from the browser or Pi, and return a clean copy. Throws with words a person can act on. */
function sanitizeGraph(raw: unknown): PipeGraph {
    const graph = (raw ?? {}) as { nodes?: unknown; edges?: unknown };
    const nodesIn = Array.isArray(graph.nodes) ? graph.nodes : [];
    const edgesIn = Array.isArray(graph.edges) ? graph.edges : [];

    if (nodesIn.length === 0) throw new Error("The pipeline has no nodes.");
    if (nodesIn.length > MAX_NODES) throw new Error(`Too many nodes (at most ${MAX_NODES}).`);

    const ids = new Set<string>();
    const nodes: PipeNode[] = nodesIn.map((rawNode, i) => {
        const node = (rawNode ?? {}) as Record<string, unknown>;
        const id = cleanText(node.id, 80) || `n${i + 1}`;
        if (ids.has(id)) throw new Error(`Two nodes have the id ${id}.`);
        ids.add(id);
        const type = cleanText(node.type, 40);
        if (!NODE_TYPES.includes(type)) throw new Error(`Unknown node type ${type || "(blank)"}.`);
        const configIn = (node.config ?? {}) as Record<string, unknown>;
        const config: Record<string, unknown> = { label: cleanText(configIn.label, 120) };
        for (const key of ["prompt", "system", "text", "template", "command", "value", "until", "model", "code", "title", "thinking", "pipeline", "onDecline", "onError", "kind", "categories", "instructions", "provider", "list", "itemTemplate", "file", "note", "strategy"]) {
            if (configIn[key] !== undefined) config[key] = cleanText(configIn[key]);
        }
        if (configIn.minConfidence !== undefined) config.minConfidence = cleanNumber(configIn.minConfidence, 0, 0, 100);
        if (configIn.threshold !== undefined) config.threshold = cleanNumber(configIn.threshold, 50, 0, 100);
        if (configIn.cut !== undefined) {
            const raw = typeof configIn.cut === "number" && Number.isFinite(configIn.cut) ? configIn.cut : NaN;
            if (Number.isFinite(raw)) config.cut = Math.min(9, Math.max(0, Math.round(raw * 10) / 10));
        }
        if (configIn.askInput !== undefined) config.askInput = configIn.askInput === true;
        if (configIn.mode !== undefined) config.mode = cleanText(configIn.mode, 40);
        if (configIn.maxItems !== undefined) config.maxItems = cleanNumber(configIn.maxItems, 30, 1, 100);
        if (configIn.concurrency !== undefined) config.concurrency = cleanNumber(configIn.concurrency, 4, 1, 8);
        if (configIn.budget !== undefined) config.budget = cleanNumber(configIn.budget, 50000, 100, 500000);
        if (configIn.keep !== undefined) config.keep = cleanNumber(configIn.keep, 10, 1, 100);
        if (configIn.maxVisits !== undefined) config.maxVisits = cleanNumber(configIn.maxVisits, 3, 1, 10);
        if (configIn.times !== undefined) config.times = cleanNumber(configIn.times, 3, 1, 20);
        if (configIn.timeout !== undefined) config.timeout = cleanNumber(configIn.timeout, 120, 1, 600);
        if (type === "map") {
            if (cleanText(config.pipeline, 200).trim() === "") throw new Error(`Map step ${id} needs a pipeline to run per item.`);
            if (cleanText(config.list, 20000).trim() === "") throw new Error(`Map step ${id} needs a list (JSON array, one item per line, or file:path).`);
        }
        if (type === "merge") {
            const strategy = cleanText(config.strategy, 20) || "summarize-rest";
            if (strategy !== "summarize-rest" && strategy !== "drop-rest") {
                throw new Error(`Merge step ${id} has strategy ${strategy || "(blank)"}: use summarize-rest or drop-rest.`);
            }
            config.strategy = strategy;
        }
        if (type === "write" || type === "read") {
            const file = cleanText(config.file, 500).trim();
            if (file === "" || file.startsWith("/") || file.split("/").includes("..")) {
                throw new Error(`Step ${id} needs a relative file path inside the run folder (no absolute paths, no ..).`);
            }
            config.file = file;
            if (type === "write" && cleanText(config.text, 200000) === "") {
                throw new Error(`Write step ${id} needs text to write.`);
            }
        }
        if (type === "decision") {
            const provider = cleanText(config.provider, 20) || "jev";
            if (provider !== "jev" && provider !== "openrouter" && provider !== "openai") {
                throw new Error(`Decision step ${id} has provider ${provider || "(blank)"}: use jev, openrouter, or openai.`);
            }
            config.provider = provider;
            const kind = cleanText(config.kind, 20) || "choice";
            if (kind !== "choice" && kind !== "noul" && kind !== "score") {
                throw new Error(`Decision step ${id} has kind ${kind || "(blank)"}: use choice, noul, or score.`);
            }
            config.kind = kind;
            if (cleanText(config.instructions, 2000).trim() === "") throw new Error(`Decision step ${id} needs instructions (the question to judge).`);
            if (kind === "choice" || kind === "score") {
                const cats = parseCategories(cleanText(config.categories, 8000));
                if (kind === "score" && cats.length < 2) {
                    throw new Error(`Decision step ${id} needs at least 2 levels ("label: when it applies", one per line, at most 10).`);
                }
                if (cats.length === 0) throw new Error(`Decision step ${id} needs at least one category ("name: when it applies", one per line).`);
                config.categories = cats.map((c) => `${c.name}: ${c.desc}`).join("\n");
            }
        }
        return {
            id,
            type,
            x: cleanNumber(node.x as number, 80 + i * 40, -4000, 8000),
            y: cleanNumber(node.y as number, 80 + i * 40, -4000, 8000),
            config,
        };
    });

    if (edgesIn.length > MAX_EDGES) throw new Error(`Too many connections (at most ${MAX_EDGES}).`);
    const edges: PipeEdge[] = [];
    for (const rawEdge of edgesIn) {
        const edge = (rawEdge ?? {}) as Record<string, unknown>;
        const from = cleanText(edge.from, 80);
        const to = cleanText(edge.to, 80);
        if (!ids.has(from) || !ids.has(to) || from === to) continue;
        const when = cleanText(edge.when, 80);
        const note = cleanText((edge as { note?: unknown }).note, 2000);
        edges.push({
            id: cleanText(edge.id, 80) || `e${edges.length + 1}`,
            from,
            to,
            ...(when === "" ? {} : { when }),
            ...(note === "" ? {} : { note }),
        });
    }
    return { nodes, edges };
}

function labelOf(node: PipeNode): string {
    return cleanText(node.config.label, 120) || node.type;
}

/** One "name: when it applies" line per category, for Decision (choice) steps. */
function parseCategories(text: string): { name: string; desc: string }[] {
    const out: { name: string; desc: string }[] = [];
    for (const line of text.split("\n")) {
        const t = line.trim();
        if (t === "" || t.startsWith("#")) continue;
        const colon = t.indexOf(":");
        const name = (colon < 0 ? t : t.slice(0, colon)).trim().slice(0, 80);
        const desc = (colon < 0 ? "" : t.slice(colon + 1)).trim().slice(0, 2000);
        if (name === "") continue;
        out.push({ name, desc: desc || name });
    }
    const seen = new Set<string>();
    for (const c of out) {
        if (seen.has(c.name)) throw new Error(`Two categories named ${c.name}.`);
        seen.add(c.name);
    }
    if (out.length > 64) throw new Error("At most 64 categories.");
    return out;
}

/** The text of an HTML page, roughly: no scripts, styles, or tags, common entities decoded. */
function pageText(html: string): string {
    return html
        .replace(/<(script|style|noscript)\b[\s\S]*?<\/\1\s*>/gi, " ")
        .replace(/<!--[\s\S]*?-->/g, " ")
        .replace(/<\/(p|div|li|h[1-6]|tr|br|section|article)\s*>|<br\s*\/?>/gi, "\n")
        .replace(/<[^>]*>/g, " ")
        .replace(/&nbsp;/g, " ")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, "&")
        .replace(/&#(\d+);/g, (_m, n: string) => {
            const code = Number(n);
            return Number.isFinite(code) ? String.fromCodePoint(Math.min(code, 0x10ffff)) : "";
        })
        .replace(/[ \t]+/g, " ")
        .replace(/\s*\n\s*/g, "\n")
        .trim();
}

function hash(text: string): string {
    let h = 5381;
    for (let i = 0; i < text.length; i++) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0;
    return h.toString(36);
}

/** Fill {{input}}, {{upstream}}, {{Label}}, {{node-id}}, {{index}}, {{prev}} in a template. */
function render(
    template: string,
    ctx: { input: string; upstream: string; outputs: Map<string, string>; nodes: PipeNode[]; index?: number; prev?: string; item?: unknown; params?: Record<string, string> },
): string {
    return template.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_all, name: string) => {
        const key = name.trim();
        if (key === "input") return ctx.input;
        if (key === "upstream") return ctx.upstream;
        if (key === "prev" || key === "current") return ctx.prev ?? ctx.upstream;
        if (key === "index") return ctx.index === undefined ? "" : String(ctx.index);
        if (key === "item") {
            return ctx.item === undefined ? "" : typeof ctx.item === "string" ? ctx.item : JSON.stringify(ctx.item) ?? "";
        }
        if (key.startsWith("param:")) return ctx.params?.[key.slice(6).trim()] ?? "";
        if (ctx.outputs.has(key)) return ctx.outputs.get(key) ?? "";
        const byLabel = ctx.nodes.find((n) => labelOf(n).toLowerCase() === key.toLowerCase());
        return byLabel ? (ctx.outputs.get(byLabel.id) ?? "") : "";
    });
}

function upstreamOf(
    node: PipeNode,
    graph: PipeGraph,
    outputs: Record<string, string>,
    skipped: Set<string>,
    edges: PipeEdge[] = graph.edges,
): { active: PipeNode[]; settled: boolean } {
    const incoming = edges.filter((e) => e.to === node.id);
    const active: PipeNode[] = [];
    let settled = true;
    for (const edge of incoming) {
        const from = graph.nodes.find((n) => n.id === edge.from);
        if (!from) continue;
        const done = Object.hasOwn(outputs, from.id);
        if (!done && !skipped.has(from.id)) settled = false;
        if (done && (edge.when === undefined || outputs[from.id] === edge.when)) active.push(from);
    }
    return { active, settled: incoming.length === 0 ? true : settled };
}

/** The ids of loop-back edges: DFS from the graph's sources, an edge to a DFS ancestor closes a loop.
 * Loop-back edges never gate readiness — they only fire at completion time, when their target already finished. */
function loopEdgeIds(graph: PipeGraph): Set<string> {
    const WHITE = 0, GRAY = 1, BLACK = 2;
    const color = new Map(graph.nodes.map((n) => [n.id, WHITE]));
    const back = new Set<string>();
    const outOf = (id: string) => graph.edges.filter((e) => e.from === id);
    const visit = (start: string) => {
        const stack: { id: string; edgeIdx: number }[] = [{ id: start, edgeIdx: 0 }];
        color.set(start, GRAY);
        while (stack.length > 0) {
            const top = stack[stack.length - 1]!;
            const edges = outOf(top.id);
            if (top.edgeIdx >= edges.length) {
                color.set(top.id, BLACK);
                stack.pop();
                continue;
            }
            const edge = edges[top.edgeIdx++]!;
            const c = color.get(edge.to) ?? BLACK;
            if (c === GRAY) back.add(edge.id);
            else if (c === WHITE) {
                color.set(edge.to, GRAY);
                stack.push({ id: edge.to, edgeIdx: 0 });
            }
        }
    };
    const sources = graph.nodes.filter((n) => graph.edges.every((e) => e.to !== n.id));
    for (const n of [...sources, ...graph.nodes]) {
        if (color.get(n.id) === WHITE) visit(n.id);
    }
    return back;
}


const textOf = (reply: { content: readonly { type: string; text?: string }[] }): string =>
    reply.content.flatMap((part) => (part.type === "text" ? [part.text ?? ""] : [])).join("");

// ─── The durable run task ────────────────────────────────────────────────────

type RunInput = { runId: string };
type RunState = { phase: "step"; step: number };

function makeCredentials(host: Host, web: Web) {
/**
 * The credentials store: server-side keys for each classifier provider.
 * Order: Pipelines settings → owner's Secrets catalog → server environment.
 * The catalog keeps its rules: ask-gated secrets are refused (Decision steps run
 * unattended), folder limits and the owner-only rule apply.
 */
const CATALOG_NAMES = {
    jev: ["TYPESAFE_API_KEY", "JEV_API_KEY"],
    openrouter: ["OPENROUTER_API_KEY", "OPENROUTER"],
    openai: ["OPENAI_API_KEY", "OPENAI"],
} as const;

type CatalogEntry = { value: string; folders: string[]; guests: boolean; ask: boolean };

function readCatalog(): { owner?: string; items: Map<string, CatalogEntry> } {
    const empty = { items: new Map<string, CatalogEntry>() };
    try {
        const dir = (host as { dataDir?: unknown }).dataDir;
        if (typeof dir !== "string" || dir === "") return empty;
        const raw = readFileSync(join(dir, "secrets", "secrets.json"), "utf8");
        const parsed = JSON.parse(raw) as {
            owner?: unknown;
            secrets?: Record<string, { value?: unknown; folders?: unknown; guests?: unknown; ask?: unknown }>;
        };
        const items = parsed?.secrets;
        if (typeof items !== "object" || items === null || Array.isArray(items)) return empty;
        const out: { owner?: string; items: Map<string, CatalogEntry> } = {
            items: new Map(),
            ...(typeof parsed.owner === "string" ? { owner: parsed.owner } : {}),
        };
        for (const [name, item] of Object.entries(items)) {
            if (/^[A-Z_][A-Z0-9_]{0,63}$/.test(name) && typeof item?.value === "string" && item.value !== "") {
                out.items.set(name, {
                    value: item.value,
                    folders: Array.isArray(item.folders) ? item.folders.filter((f): f is string => typeof f === "string") : [],
                    guests: item.guests === true,
                    ask: item.ask === true,
                });
            }
        }
        return out;
    } catch {
        return empty;
    }
}

const within = (cwd: string, folder: string) =>
    cwd === folder || cwd.startsWith(folder.endsWith("/") ? folder : `${folder}/`);

const hiddenKeys = new Set<string>();
const hiddenStoppers: (() => void)[] = [];
web.onDispose(() => {
    for (const stop of hiddenStoppers.splice(0)) {
        try {
            stop();
        } catch {
            /* already gone */
        }
    }
});

/** Mask a key everywhere Pi and people read, so it can never leak by accident. */
function keepHidden(value: string, label: string) {
    if (value === "" || hiddenKeys.has(value) || hiddenKeys.size >= 200) return;
    if (typeof host.hide !== "function") return;
    try {
        hiddenStoppers.push(host.hide({ value, label: `secret ${label.slice(0, 52)}` }));
        hiddenKeys.add(value);
    } catch {
        /* hiding is best-effort; the key still never enters any text we produce */
    }
}

async function resolveClassifierKey(
    provider: "jev" | "openrouter" | "openai",
    runtime: { agent: (c: never) => Promise<{ cwd?: string }> },
    context: never,
    conversationId: number,
): Promise<string> {
    const settingName = provider === "jev" ? "jevKey" : provider === "openrouter" ? "openrouterKey" : "openaiKey";
    const fromSetting = typeof web.setting === "function" ? cleanText(web.setting(settingName), 500).trim() : "";
    if (fromSetting !== "") {
        keepHidden(fromSetting, settingName);
        return fromSetting;
    }
    const catalog = readCatalog();
    for (const name of CATALOG_NAMES[provider]) {
        const entry = catalog.items.get(name);
        if (entry === undefined) continue;
        if (entry.ask) {
            throw new Error(
                `Secret $${name} waits for a person to allow each use. Decision steps run on their own: turn off “ask each use” for pipeline keys, or paste the key in Pipelines settings.`,
            );
        }
        if (entry.folders.length > 0) {
            const cwd = (await runtime.agent(context)).cwd ?? process.cwd();
            if (!entry.folders.some((f) => within(cwd, f))) {
                throw new Error(`Secret $${name} may be used only in ${entry.folders.join(", ")}.`);
            }
        }
        if (!entry.guests) {
            const by = typeof host.requesterOf === "function" ? host.requesterOf(conversationId as never) : undefined;
            if (by !== undefined && catalog.owner !== undefined && by !== catalog.owner) {
                throw new Error(`Secret $${name} is the owner's: Decision steps using it run only for the owner.`);
            }
            if (by !== undefined && catalog.owner === undefined) {
                throw new Error(`Secret $${name} waits until the owner opens Pi Pocket once with Secrets on.`);
            }
        }
        keepHidden(entry.value, name);
        return entry.value;
    }
    const envName = provider === "jev" ? "TYPESAFE_API_KEY" : provider === "openrouter" ? "OPENROUTER_API_KEY" : "OPENAI_API_KEY";
    return (process.env[envName] ?? "").trim();
}

/** Whether any source holds a key for this provider (settings, catalog, or environment). */
function hasKey(provider: "jev" | "openrouter" | "openai"): boolean {
    const settingName = provider === "jev" ? "jevKey" : provider === "openrouter" ? "openrouterKey" : "openaiKey";
    if (typeof web.setting === "function" && cleanText(web.setting(settingName), 500).trim() !== "") return true;
    const catalog = readCatalog();
    if (CATALOG_NAMES[provider].some((n) => catalog.items.has(n))) return true;
    const envName = provider === "jev" ? "TYPESAFE_API_KEY" : provider === "openrouter" ? "OPENROUTER_API_KEY" : "OPENAI_API_KEY";
    return (process.env[envName] ?? "").trim() !== "";
}
    return { resolveClassifierKey, hasKey };
}

function runTaskFor(host: Host, web: Web, creds: Pick<ReturnType<typeof makeCredentials>, "resolveClassifierKey">) {
    /** The model a node runs on: its own choice, or the run session's, checked against the owner's list. */
    async function resolveRef(
        runtime: { agent: (c: never) => Promise<{ model?: { provider: string; modelId: string } }>; conversationId: number },
        context: never,
        node: PipeNode,
    ): Promise<{ provider: string; modelId: string }> {
        const allowed = typeof host.subagentModels === "function" ? host.subagentModels() : [];
        const agent = await runtime.agent(context);
        const wanted = cleanText(node.config.model, 200).trim();
        let ref = agent.model;
        if (wanted !== "") {
            const slash = wanted.indexOf("/");
            if (slash <= 0) throw new Error(`Model ${wanted} must be provider/modelId.`);
            ref = { provider: wanted.slice(0, slash), modelId: wanted.slice(slash + 1) };
            if (allowed.length > 0 && !allowed.includes(wanted)) {
                throw new Error(`${wanted} is not one of the models the owner allows (${allowed.join(", ")}).`);
            }
        } else if (allowed.length > 0 && (ref === undefined || !allowed.includes(`${ref.provider}/${ref.modelId}`))) {
            throw new Error(
                `This session's model is not on the owner's list for pipelines (${allowed.join(", ")}). Pick a model on the node.`,
            );
        }
        if (ref === undefined) throw new Error("The run's session has no model.");
        return ref;
    }

    async function callModel(
        runtime: { agent: (c: never) => Promise<{ model?: { provider: string; modelId: string } }>; models: { getModel: (p: string, id: string) => unknown; completeSimple: (m: never, body: never, opts?: never) => Promise<never> }; conversationId: number },
        context: never,
        node: PipeNode,
        prompt: string,
        system: string,
    ): Promise<{ text: string; usage?: unknown; modelKey?: string }> {
        const ref = await resolveRef(runtime, context, node);
        if (typeof host.heldBack === "function" && host.heldBack(runtime.conversationId) !== undefined) {
            throw new Error(host.heldBack(runtime.conversationId));
        }
        const model = runtime.models.getModel(ref.provider, ref.modelId);
        if (model === undefined) throw new Error(`No such model ${ref.provider}/${ref.modelId}.`);
        const messages = [
            ...(system.trim() === ""
                ? []
                : [{ role: "system", content: system, timestamp: Date.now() }]),
            { role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() },
        ];
        const reply = (await runtime.models.completeSimple(model as never, { messages } as never)) as unknown as {
            content: readonly { type: string; text?: string }[];
            stopReason?: string;
            errorMessage?: string;
            usage?: unknown;
        };
        const text = textOf(reply);
        if (reply.stopReason === "error" || reply.stopReason === "aborted") {
            throw new Error(reply.errorMessage ?? `The model stopped (${reply.stopReason}).`);
        }
        return { text, usage: reply.usage, modelKey: `${ref.provider}/${ref.modelId}` };
    }

    /** The credentials store: server-side keys for each classifier provider. Settings first, environment fallback. */

    type Classified = {
        text: string;
        detail: string;
        modelKey: string;
        usage: {
            input: number;
            output: number;
            cacheRead: number;
            cacheWrite: number;
            totalTokens: number;
            cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
        };
    };

    async function postClassifier(url: string, key: string, body: unknown, extraHeaders: Record<string, string>, label: string): Promise<{ data: never; usageIn: number; usageOut: number }> {
        let res: Response;
        try {
            res = await fetch(url, {
                method: "POST",
                headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...extraHeaders },
                body: JSON.stringify(body),
                signal: AbortSignal.timeout(60_000),
            });
        } catch (error) {
            throw new Error(`${label} request failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (!res.ok) {
            if (res.status === 401 || res.status === 403) {
                throw new Error(`${label} refused the API key (401/403). Check the key in Pipelines settings.`);
            }
            throw new Error(`${label} error ${res.status}: ${(await res.text()).slice(0, 500)}`);
        }
        const data = (await res.json()) as never;
        const u = (data as { usage?: { input_tokens?: number; output_tokens?: number; prompt_tokens?: number; completion_tokens?: number } }).usage ?? {};
        return { data, usageIn: u.input_tokens ?? u.prompt_tokens ?? 0, usageOut: u.output_tokens ?? u.completion_tokens ?? 0 };
    }

    /**
     * Classify text with any decision-model provider. Choice picks one category (outputs its name),
     * Noul/predicate answers yes/no (outputs true/false), Score rates against ordered levels (outputs high/low).
     * Below the confidence bar the step outputs unsure, for an edge to route to review.
     */
    async function classifyDecision(
        node: PipeNode,
        stateText: string,
        runInput: string,
        runtime: { agent: (c: never) => Promise<{ cwd?: string }> },
        context: never,
        conversationId: number,
    ): Promise<Classified> {
        const provider = (cleanText(node.config.provider, 20) || "jev") as "jev" | "openrouter" | "openai";
        const key = await creds.resolveClassifierKey(provider, runtime, context, conversationId);
        if (key === "") {
            const hint =
                provider === "jev"
                    ? "TYPESAFE_API_KEY"
                    : provider === "openrouter"
                      ? "OPENROUTER_API_KEY"
                      : "OPENAI_API_KEY";
            throw new Error(
                `Decision steps on ${provider} need an API key: add it to the Secrets catalog (Menu → Secrets, e.g. $${hint.replace("_API_KEY", "")}), Pipelines settings, or ${hint} on the server.`,
            );
        }
        const kind = cleanText(node.config.kind, 20) || "choice";
        const instructions = render(cleanText(node.config.instructions, 2000), {
            input: runInput,
            upstream: stateText,
            outputs: new Map(),
            nodes: [],
        });
        const cats = parseCategories(cleanText(node.config.categories, 8000));
        const minConf = cleanNumber(node.config.minConfidence, 0, 0, 100) / 100;
        const zeroUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
        const withUsage = (usageIn: number, usageOut: number) => ({
            ...zeroUsage,
            input: usageIn,
            output: usageOut,
            totalTokens: usageIn + usageOut,
        });

        if (provider === "openai") {
            const model = cleanText(node.config.model, 60) || "gpt-6-luna";
            const modelKey = `openai/${model}`;
            const question =
                kind === "noul"
                    ? { type: "predicate", name: "q", instructions }
                    : kind === "score"
                      ? {
                            type: "score",
                            name: "q",
                            instructions,
                            levels: cats.map((c) => ({ label: c.name, description: c.desc })),
                        }
                      : {
                            type: "choice",
                            name: "q",
                            instructions,
                            choices: cats.map((c) => ({ value: c.name, description: c.desc })),
                        };
            const { data, usageIn, usageOut } = await postClassifier(
                "https://api.openai.com/v1/decisions",
                key,
                { model, input: stateText.slice(0, 20000), questions: [question] },
                {},
                "OpenAI Decisions",
            );
            const answer = (data as { answers?: { name?: string; type?: string; probability?: number; choice?: string; confidence?: number; score?: number }[] }).answers?.find((a) => a.name === "q");
            if (answer === undefined) throw new Error("OpenAI Decisions answered without a decision.");
            if (answer.type === "refusal") throw new Error("OpenAI refused to judge this text (refusal). Rephrase or route it to review.");
            const usage = withUsage(usageIn, usageOut);
            if (kind === "noul" && answer.type === "predicate") {
                const p = answer.probability ?? NaN;
                if (!Number.isFinite(p)) throw new Error("OpenAI answered without a probability.");
                const threshold = cleanNumber(node.config.threshold, 50, 0, 100) / 100;
                const conf = p >= threshold ? p : 1 - p;
                const text = conf < minConf ? "unsure" : p >= threshold ? "true" : "false";
                return { text, detail: `P(yes) ${(p * 100).toFixed(0)}% → ${text}`, modelKey, usage };
            }
            if (kind === "score" && answer.type === "score") {
                const score = answer.score ?? NaN;
                const conf = answer.confidence ?? NaN;
                if (!Number.isFinite(score)) throw new Error("OpenAI answered without a score.");
                const cut = typeof node.config.cut === "number" ? node.config.cut : (cats.length - 1) / 2;
                const text = Number.isFinite(conf) && conf < minConf ? "unsure" : score >= cut ? "high" : "low";
                return { text, detail: `score ${score.toFixed(1)} → ${text}`, modelKey, usage };
            }
            if (kind === "choice" && answer.type === "choice") {
                const winner = answer.choice ?? "";
                const conf = answer.confidence ?? NaN;
                if (winner === "" || !Number.isFinite(conf)) throw new Error("OpenAI answered without a category.");
                if (conf < minConf) return { text: "unsure", detail: `best ${winner} (${(conf * 100).toFixed(0)}%) below bar`, modelKey, usage };
                return { text: winner, detail: `${winner} (${(conf * 100).toFixed(0)}%)`, modelKey, usage };
            }
            throw new Error(`OpenAI answered a ${answer.type ?? "unknown"} for a ${kind} question.`);
        }

        // Jev shapes, direct or through OpenRouter (same System One contract).
        const isOR = provider === "openrouter";
        const model = cleanText(node.config.model, 60) || (isOR ? "typesafe/jev-1.14" : "jev-latest");
        const modelKey = `${isOR ? "openrouter" : "typesafe"}/${model}`;
        const question =
            kind === "noul"
                ? { type: "noul", instructions }
                : kind === "score"
                  ? { type: "score", instructions, criteria: cats.map((c) => c.desc) }
                  : {
                        type: "choice",
                        instructions,
                        criteria: Object.fromEntries(cats.map((c) => [c.name, c.desc])),
                    };
        const { data, usageIn, usageOut } = await postClassifier(
            isOR ? "https://openrouter.ai/api/v1/systemone" : "https://api.typesafe.ai/v1/systemone",
            key,
            { model, state: stateText.slice(0, 20000), questions: { q: question } },
            isOR ? { "HTTP-Referer": "https://github.com/stilllostinla/pi-pocket-pipelines", "X-Title": "Pipelines" } : {},
            isOR ? "OpenRouter Jev" : "Jev",
        );
        const answer = (data as { answers?: { q?: { type?: string; choice?: string; confidence?: number; probabilities?: Record<string, number>; noul?: number; score?: number; legend?: Record<string, string> } } }).answers?.q;
        if (answer === undefined) throw new Error(`${isOR ? "OpenRouter Jev" : "Jev"} answered without a decision.`);
        const usage = withUsage(usageIn, usageOut);
        if (kind === "noul") {
            const p = typeof answer.noul === "number" ? answer.noul : NaN;
            if (!Number.isFinite(p)) throw new Error("The classifier answered without a yes/no probability.");
            const threshold = cleanNumber(node.config.threshold, 50, 0, 100) / 100;
            const conf = p >= threshold ? p : 1 - p;
            const text = conf < minConf ? "unsure" : p >= threshold ? "true" : "false";
            return { text, detail: `P(yes) ${(p * 100).toFixed(0)}% → ${text}`, modelKey, usage };
        }
        if (kind === "score") {
            const score = typeof answer.score === "number" ? answer.score : NaN;
            const conf = typeof answer.confidence === "number" ? answer.confidence : NaN;
            if (!Number.isFinite(score)) throw new Error("The classifier answered without a score.");
            const cut = typeof node.config.cut === "number" ? node.config.cut : (cats.length - 1) / 2;
            const text = Number.isFinite(conf) && conf < minConf ? "unsure" : score >= cut ? "high" : "low";
            return { text, detail: `score ${score.toFixed(1)} → ${text}`, modelKey, usage };
        }
        const winner = typeof answer.choice === "string" ? answer.choice : "";
        const conf = typeof answer.confidence === "number" ? answer.confidence : NaN;
        if (winner === "" || !Number.isFinite(conf)) throw new Error("The classifier answered without a category.");
        if (conf < minConf) return { text: "unsure", detail: `best ${winner} (${(conf * 100).toFixed(0)}%) below bar`, modelKey, usage };
        const probs = Object.entries(answer.probabilities ?? {}).sort((a, b) => b[1] - a[1]);
        const runnerUp = probs.find(([name]) => name !== winner);
        const detail =
            `${winner} (${(conf * 100).toFixed(0)}%)` +
            (runnerUp ? `, next ${runnerUp[0]} (${((runnerUp[1] ?? 0) * 100).toFixed(0)}%)` : "");
        return { text: winner, detail, modelKey, usage };
    }

    /** Run a saved pipeline as a child of this run's task and return its output text. The child run id is fixed,
     * so a restart that reruns this phase finds the same child instead of starting another. */
    async function runChildPipeline(
        rt: {
            commit: <T>(change: (tx: never) => T | Promise<T>, context: never) => Promise<T>;
            snapshot: (doc: never, context: never) => Promise<{ items: Record<string, PipeRun> } | undefined>;
            waitForTask: (id: never, context: never) => Promise<unknown>;
            taskId: unknown;
        },
        context: never,
        run: PipeRun,
        subDef: PipeDef,
        subInput: string,
        runId: string,
        launchNote: string,
    ): Promise<string> {
        const depth = run.depth ?? 0;
        if (depth >= 3) throw new Error("Sub-pipelines nest at most 3 deep.");
        let subTaskId: number | undefined;
        await rt.commit(async (tx) => {
            const t = tx as unknown as {
                doc: (token: never) => Promise<{ items: Record<string, PipeRun> }>;
                createTask: (task: never, input: never, options: never) => Promise<number>;
            };
            const doc = await t.doc(RunsDoc as never);
            const existing = doc.items[runId];
            if (existing !== undefined && existing.taskId !== undefined) {
                subTaskId = existing.taskId;
                return undefined;
            }
            const childRun: PipeRun = {
                id: runId,
                pipelineId: subDef.id,
                name: `${subDef.name} (in ${run.name})`,
                graph: JSON.parse(JSON.stringify(subDef.graph)) as PipeGraph,
                input: subInput.slice(0, 20_000),
                conversationId: run.conversationId,
                status: "queued",
                outputs: {},
                skipped: [],
                current: [],
                steps: 0,
                log: [{ at: Date.now(), text: launchNote }],
                params: run.params == undefined ? undefined : { ...run.params },
                depth: depth + 1,
                parentRunId: run.id,
                createdAt: Date.now(),
            };
            doc.items[runId] = childRun;
            childRun.taskId = (await t.createTask(RunTaskDef as never, { runId } as never, {
                ownership: { kind: "task", taskId: rt.taskId },
                conversationId: run.conversationId as never,
            } as never)) as unknown as number;
            subTaskId = childRun.taskId;
            return undefined;
        }, context);
        const settledTask = await rt.waitForTask(subTaskId as never, context);
        const subRun = (await rt.snapshot(RunsDoc as never, context))?.items[runId];
        if ((settledTask as unknown as { state: { outcome?: { status: string } } }).state.outcome?.status !== "completed" || subRun?.status !== "done") {
            throw new Error(`Sub-pipeline ${subDef.name} failed: ${subRun?.error ?? "see its run in the runs list"}`);
        }
        const outNodes = subDef.graph.nodes.filter((n) => n.type === "output");
        const picked = (outNodes.length > 0 ? outNodes : subDef.graph.nodes)
            .map((n) => subRun.outputs[n.id])
            .filter((v): v is string => v !== undefined);
        return picked.join("\n\n");
    }

    /** Resolve a Map step's list: a JSON array, one item per line, file:path, or folder:path (.txt files). */
    async function resolveMapList(
        rt: { env: (context: never) => Promise<{ readTextFile: (p: string, c: never) => Promise<{ ok: boolean; value?: string; error?: { message: string } }>; listDir: (p: string, c: never) => Promise<{ ok: boolean; value?: { path: string; kind: string }[]; error?: { message: string } }> } | undefined> },
        context: never,
        rawList: string,
    ): Promise<unknown[]> {
        let raw = rawList.trim();
        const checkRel = (rel: string, what: string) => {
            if (rel === "" || rel.startsWith("/") || rel.split("/").includes("..")) {
                throw new Error(`Map list ${what} must be relative, no ..: ${rel}.`);
            }
        };
        const folderMatch = /^folder:(.+)$/is.exec(raw);
        if (folderMatch) {
            const rel = folderMatch[1].trim();
            checkRel(rel, "folder");
            const env = await rt.env(context);
            if (env === undefined) throw new Error("This session has no shell environment.");
            const r = await env.listDir(rel, context);
            if (!r.ok) throw new Error(`Could not list map folder ${rel}: ${r.error?.message ?? "unknown error"}`);
            return (r.value ?? []).filter((e) => e.kind === "file" && /\.txt$/i.test(e.path)).map((e) => e.path).sort();
        }
        const fileMatch = /^file:(.+)$/is.exec(raw);
        if (fileMatch) {
            const rel = fileMatch[1].trim();
            if (rel === "" || rel.startsWith("/") || rel.split("/").includes("..")) {
                throw new Error(`Map list file must be relative, no ..: ${rel}.`);
            }
            const env = await rt.env(context);
            if (env === undefined) throw new Error("This session has no shell environment.");
            const r = await env.readTextFile(rel, context);
            if (!r.ok) throw new Error(`Could not read map list ${rel}: ${r.error?.message ?? "unknown error"}`);
            raw = (r.value ?? "").trim();
        }
        if (raw === "") return [];
        if (raw.startsWith("[") || raw.startsWith("{")) {
            let parsed: unknown;
            try {
                parsed = JSON.parse(raw);
            } catch {
                throw new Error("Map list looks like JSON but does not parse.");
            }
            return Array.isArray(parsed) ? parsed : [parsed];
        }
        return raw.split("\n").map((s) => s.trim()).filter((s) => s !== "");
    }

    const RunTaskDef = defineTask<RunInput, RunState, null>({
        name: "x.pipelines.run",
        version: 1,
        initial: () => ({ phase: "step", step: 0 }),
        phases: {
            step: async (task, runtime, context) => {
                const defsRun = (await runtime.snapshot(RunsDoc, context))?.items[task.input.runId];
                if (defsRun === undefined) {
                    await runtime.commit(
                        () => ({ status: "terminal", outcome: { status: "completed", result: null } }),
                        context,
                    );
                    return;
                }
                const run: PipeRun = JSON.parse(JSON.stringify(defsRun)) as PipeRun;
                const graph = run.graph;

                const fail = async (message: string) => {
                    await runtime.commit(async (tx) => {
                        const doc = await tx.doc(RunsDoc);
                        const item = doc.items[task.input.runId];
                        if (item !== undefined) {
                            item.status = "failed";
                            item.error = message.slice(0, 2000);
                            item.current = [];
                            item.endedAt = Date.now();
                            item.log = [...item.log, { at: Date.now(), text: `Failed: ${message}` }].slice(-100);
                        }
                        return {
                            status: "terminal",
                            outcome: { status: "failed", error: { message: message.slice(0, 500) } },
                        } as const;
                    }, context);
                    web.send("run", { ...(await runtime.snapshot(RunsDoc, context))?.items[task.input.runId] });
                };

                if (run.status === "done" || run.status === "failed" || run.status === "stopped") {
                    await runtime.commit(
                        () => ({ status: "terminal", outcome: { status: "completed", result: null } }),
                        context,
                    );
                    return;
                }
                if (run.stopRequested === true) {
                    await runtime.commit(async (tx) => {
                        const doc = await tx.doc(RunsDoc);
                        const item = doc.items[task.input.runId];
                        if (item !== undefined) {
                            item.status = "stopped";
                            item.current = [];
                            item.endedAt = Date.now();
                            item.log = [...item.log, { at: Date.now(), text: "Stopped." }].slice(-100);
                        }
                        return { status: "terminal", outcome: { status: "aborted", reason: "stopped" } } as const;
                    }, context);
                    web.send("run", { ...(await runtime.snapshot(RunsDoc, context))?.items[task.input.runId] });
                    return;
                }
                if (run.steps > 400) {
                    await fail("The run passed 400 steps and was stopped.");
                    return;
                }

                const outputsMap = new Map(Object.entries(run.outputs));
                const skipped = new Set(run.skipped);
                // Loop-back edges never gate readiness: they only fire at completion time.
                const loopIds = loopEdgeIds(graph);
                const fwdEdges = graph.edges.filter((e) => !loopIds.has(e.id));

                // Settle skips: a node whose inputs all settled but none is active (a branch went the other way).
                let changed = true;
                while (changed) {
                    changed = false;
                    for (const node of graph.nodes) {
                        if (outputsMap.has(node.id) || skipped.has(node.id)) continue;
                        const incoming = fwdEdges.filter((e) => e.to === node.id);
                        if (incoming.length === 0) continue;
                        const { active, settled } = upstreamOf(node, graph, run.outputs, skipped, fwdEdges);
                        if (settled && active.length === 0) {
                            skipped.add(node.id);
                            changed = true;
                        }
                    }
                }

                const ready = graph.nodes.filter((node) => {
                    if (outputsMap.has(node.id) || skipped.has(node.id)) return false;
                    const { active, settled } = upstreamOf(node, graph, run.outputs, skipped, fwdEdges);
                    return settled && (fwdEdges.every((e) => e.to !== node.id) || active.length > 0);
                });

                const settledCount = outputsMap.size + skipped.size;
                if (ready.length === 0) {
                    if (settledCount >= graph.nodes.length) {
                        await runtime.commit(async (tx) => {
                            const doc = await tx.doc(RunsDoc);
                            const item = doc.items[task.input.runId];
                            if (item !== undefined) {
                                item.status = "done";
                                item.skipped = [...skipped];
                                item.current = [];
                                item.endedAt = Date.now();
                                item.log = [
                                    ...item.log,
                                    {
                                        at: Date.now(),
                                        text:
                                            Object.keys(item.failedNodes ?? {}).length > 0
                                                ? `Done (${Object.keys(item.failedNodes ?? {}).length} step(s) failed and were continued without).`
                                                : "Done.",
                                    },
                                ].slice(-100);
                            }
                            return { status: "terminal", outcome: { status: "completed", result: null } } as const;
                        }, context);
                        web.send("run", { ...(await runtime.snapshot(RunsDoc, context))?.items[task.input.runId] });
                    } else {
                        await fail("No node can run next (a connection points at a node that never settles).");
                    }
                    return;
                }

                // Execute one ready batch in parallel (fan-out). Each result is memoized first, so a restart
                // that reruns this phase finds finished nodes instead of calling their models again.
                const usages: { key: string; usage: never }[] = [];
                const notes: { nodeId: string; text: string }[] = [];
                const fileNotes: { nodeId: string; path: string; bytes: number; label: string }[] = [];
                const results = await Promise.allSettled(
                    ready.map(async (node) => {
                        const { active } = upstreamOf(node, graph, run.outputs, skipped, fwdEdges);
                        const baseUpstream = active.map((n) => run.outputs[n.id] ?? "").join("\n\n");
                        const loopNote = run.loopNotes?.[node.id];
                        const upstream = loopNote ? `${baseUpstream}${baseUpstream === "" ? "" : "\n\n"}${loopNote}` : baseUpstream;
                        const ctx = { input: run.input, upstream, outputs: outputsMap, nodes: graph.nodes, params: run.params ?? {} };
                        const memoKey = `n:${node.id}:${hash(JSON.stringify({ c: node.config, u: upstream, i: run.input }))}`;
                        const memo = runtime as unknown as {
                            memo: (name: string, ...rest: unknown[]) => Promise<unknown>;
                        };
                        const cached = (await memo.memo(memoKey, context)) as string | undefined;
                        if (cached !== undefined) return cached;

                        let out = "";
                        if (node.type === "input") {
                            out = run.input;
                        } else if (node.type === "prompt" || node.type === "output") {
                            out = render(cleanText(node.config.text) || "{{upstream}}", ctx);
                        } else if (node.type === "branch") {
                            const subject = render(cleanText(node.config.template) || "{{upstream}}", ctx);
                            const mode = cleanText(node.config.mode, 40) || "contains";
                            const value = cleanText(node.config.value, 2000);
                            const hit =
                                mode === "equals"
                                    ? subject.trim() === value
                                    : mode === "truthy"
                                      ? subject.trim() !== "" && subject.trim().toLowerCase() !== "false"
                                      : subject.includes(value);
                            out = hit ? "true" : "false";
                        } else if (node.type === "decision") {
                            const stateText = render(cleanText(node.config.template) || "{{upstream}}", ctx);
                            if (stateText.trim() === "") throw new Error("Decision step has nothing to judge.");
                            const decided = await classifyDecision(node, stateText, run.input, runtime as never, context as never, run.conversationId);
                            usages.push({ key: decided.modelKey, usage: decided.usage as never });
                            notes.push({ nodeId: node.id, text: `${labelOf(node)}: ${decided.detail}` });
                            out = decided.text;
                        } else if (node.type === "bash") {
                            const env = await runtime.env(context);
                            if (env === undefined) throw new Error("This session has no shell environment.");
                            const command = render(cleanText(node.config.command), ctx);
                            if (command.trim() === "") throw new Error("Shell node has no command.");
                            let text = "";
                            const result = await env.exec(
                                command,
                                {
                                    timeout: cleanNumber(node.config.timeout, 120, 1, 600),
                                    onOutput: (chunk: string) => (text = (text + chunk).slice(-20_000)),
                                } as never,
                                context,
                            );
                            if (!result.ok) throw new Error((result.error as { message: string }).message);
                            if ((result.value as { exitCode: number }).exitCode !== 0) {
                                throw new Error(`Command exited ${(result.value as { exitCode: number }).exitCode}: ${text.slice(-1000)}`);
                            }
                            out = text.trim();
                        } else if (node.type === "llm" || node.type === "refine") {
                            const system = render(cleanText(node.config.system), ctx);
                            if (node.type === "llm") {
                                const prompt = render(cleanText(node.config.prompt) || "{{upstream}}", ctx);
                                const called = await callModel(runtime as never, context as never, node, prompt, system);
                                if (called.usage !== undefined && called.modelKey !== undefined) {
                                    usages.push({ key: called.modelKey, usage: called.usage as never });
                                }
                                out = called.text;
                            } else {
                                const times = cleanNumber(node.config.times, 3, 1, 20);
                                const until = cleanText(node.config.until, 500);
                                let current = upstream;
                                for (let i = 1; i <= times; i++) {
                                    const iterKey = `${memoKey}:iter${i}:${hash(current)}`;
                                    let stepText = (await memo.memo(iterKey, context)) as string | undefined;
                                    if (stepText === undefined) {
                                        const prompt = render(cleanText(node.config.prompt) || "{{upstream}}", {
                                            ...ctx,
                                            index: i,
                                            prev: current,
                                            upstream: current,
                                        });
                                        const called = await callModel(runtime as never, context as never, node, prompt, system);
                                        if (called.usage !== undefined && called.modelKey !== undefined) {
                                            usages.push({ key: called.modelKey, usage: called.usage as never });
                                        }
                                        stepText = called.text;
                                        await memo.memo(iterKey, stepText, context);
                                    }
                                    current = stepText;
                                    if (until !== "" && current.includes(until)) break;
                                }
                                out = current;
                            }
                        } else if (node.type === "agent") {
                            // A real Pi sub-session with its own tools and transcript, owned by this run task.
                            // Its id is stored in the run first, so a restart that reruns this phase finds the
                            // same sub-session and resubmits under the same request id instead of starting another.
                            const prompt = render(cleanText(node.config.prompt) || "{{upstream}}", ctx);
                            let childId = run.agentSessions?.[node.id];
                            if (childId === undefined) {
                                const ref = await resolveRef(runtime as never, context as never, node);
                                const thinking = cleanText(node.config.thinking, 40);
                                const instructions = render(cleanText(node.config.system), ctx);
                                childId = await runtime.commit(async (tx) => {
                                    const doc = await tx.doc(RunsDoc);
                                    const item = doc.items[task.input.runId];
                                    const found = item?.agentSessions?.[node.id];
                                    if (found !== undefined) {
                                        childId = found;
                                        return undefined;
                                    }
                                    const child = await tx.createConversation({
                                        ownership: { kind: "task", taskId: runtime.taskId },
                                    });
                                    await configure(tx, child.id, {
                                        extensions: { remove: [PipelinesRef] },
                                        ...(instructions.trim() === "" ? {} : { instructions }),
                                        model: ref,
                                        ...(thinking === "" || thinking === "session"
                                            ? {}
                                            : { thinkingLevel: thinking as never }),
                                    });
                                    if (item !== undefined) {
                                        item.agentSessions = { ...(item.agentSessions ?? {}), [node.id]: child.id as unknown as number };
                                        item.log = [
                                            ...item.log,
                                            { at: Date.now(), node: node.id, text: `${labelOf(node)}: started sub-session ${String(child.id)}` },
                                        ].slice(-100);
                                    }
                                    childId = child.id as unknown as number;
                                    return undefined;
                                }, context).then(() => childId!);
                                web.send("run", { ...(await runtime.snapshot(RunsDoc, context))?.items[task.input.runId] });
                            }
                            const child = await runtime.conversation(childId as never, context);
                            if (child === undefined) throw new Error(`Agent sub-session ${String(childId)} is gone.`);
                            const settled = await (
                                await child.submit(
                                    { type: "input", content: prompt, requestId: `x.pipelines:${run.id}:${node.id}` } as never,
                                    context,
                                )
                            ).wait(context);
                            if (settled.status !== "done" || settled.type !== "input") {
                                const s = settled as unknown as { reason?: string; detail?: unknown };
                                throw new Error(`Agent did not answer (${s.reason ?? settled.status}${s.detail === undefined ? "" : `: ${String(s.detail).slice(0, 500)}`}). Open its sub-session from the run to see why.`);
                            }
                            let agentText = "";
                            await runtime.commit(async (tx) => {
                                const entry = await tx.entry(AssistantEntry, (settled as unknown as { answer: never }).answer);
                                const message = entry?.model?.[0] as { content?: readonly { type: string; text?: string }[] } | undefined;
                                agentText = (message?.content ?? []).flatMap((p) => (p.type === "text" ? [p.text ?? ""] : [])).join("");
                                return undefined;
                            }, context);
                            out = agentText;
                        } else if (node.type === "approval") {
                            if (typeof host.ask !== "function") throw new Error("Approval nodes need Pi Pocket 0.22 or newer.");
                            const answer = await host.ask(
                                {
                                    conversationId: runtime.conversationId,
                                    id: `x.pipelines:${run.id}:${node.id}`,
                                    taskId: runtime.taskId,
                                    title: (render(cleanText(node.config.title, 120) || labelOf(node), ctx) || "Pipeline approval").slice(0, 120),
                                    text: render(cleanText(node.config.text) || "{{upstream}}", ctx).slice(0, 2000),
                                    ...(node.config.askInput === true
                                        ? { fields: [{ name: "value", label: cleanText(node.config.value, 120) || "Your answer" }] }
                                        : {}),
                                },
                                context as never,
                            );
                            if (answer.answered) {
                                out = answer.values.value ?? "approved";
                            } else if (cleanText(node.config.onDecline, 20) === "branch") {
                                out = "declined";
                            } else {
                                throw new Error(`Approval declined by ${answer.by}.`);
                            }
                        } else if (node.type === "code") {
                            const code = cleanText(node.config.code, 50_000);
                            if (code.trim() === "") throw new Error("Code node has no code.");
                            const prelude = `const input = ${JSON.stringify(run.input)};\nconst upstream = ${JSON.stringify(upstream)};\nconst outputs = ${JSON.stringify(Object.fromEntries(outputsMap))};\n`;
                            const sandbox = new CodemodeSandbox({
                                tools: [],
                                timeoutMs: Math.min(60, cleanNumber(node.config.timeout, 10, 1, 600)) * 1000,
                                memoryLimitBytes: 64 * 1024 * 1024,
                            });
                            try {
                                const result = (await sandbox.execute(prelude + code, {
                                    ...(context.abortSignal === undefined ? {} : { signal: context.abortSignal }),
                                    store: {},
                                })) as unknown as {
                                    ok: boolean;
                                    output: readonly { type: string; text?: string }[];
                                    value?: unknown;
                                    error?: { kind: string; message: string; stack?: string; name?: string };
                                };
                                if (!result.ok) {
                                    throw new Error(result.error?.stack ?? result.error?.message ?? "Code node failed.");
                                }
                                const printed = result.output.flatMap((p) => (p.type === "text" ? [p.text ?? ""] : [])).join("\n");
                                out =
                                    result.value === undefined
                                        ? printed
                                        : typeof result.value === "string"
                                          ? result.value
                                          : JSON.stringify(result.value) ?? printed;
                            } finally {
                                await sandbox.close();
                            }
                        } else if (node.type === "subpipe") {
                            // Run another saved pipeline as a step: a child run of this run's task, waited on here.
                            const wanted = cleanText(node.config.pipeline, 200).trim();
                            if (wanted === "") throw new Error("Sub-pipeline node names no pipeline.");
                            const allDefs = await runtime.snapshot(DefsDoc, context);
                            const subDef =
                                allDefs?.items[wanted] ??
                                Object.values(allDefs?.items ?? {}).find((d) => d.name.toLowerCase() === wanted.toLowerCase());
                            if (subDef === undefined) throw new Error(`No pipeline ${wanted} for the sub-pipeline node.`);
                            const subInput = render(cleanText(node.config.text) || "{{upstream}}", ctx);
                            const subRunId = `${run.id}:${node.id}:sub`.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 120);
                            out = await runChildPipeline(runtime as never, context, run, subDef, subInput, subRunId, `Queued by ${run.id}.`);
                        } else if (node.type === "map") {
                            // Run one saved pipeline per item in a runtime list. Each child is its own durable
                            // run (fixed id, so restarts resume it). Sequential by default; concurrency caps speed.
                            const wanted = cleanText(node.config.pipeline, 200).trim();
                            if (wanted === "") throw new Error("Map step names no pipeline.");
                            const allDefs = await runtime.snapshot(DefsDoc, context);
                            const subDef =
                                allDefs?.items[wanted] ??
                                Object.values(allDefs?.items ?? {}).find((d) => d.name.toLowerCase() === wanted.toLowerCase());
                            if (subDef === undefined) throw new Error(`No pipeline ${wanted} for the map step.`);
                            const items = (await resolveMapList(runtime as never, context, render(cleanText(node.config.list) || "{{upstream}}", ctx))).slice(0, cleanNumber(node.config.maxItems, 30, 1, 100));
                            if (items.length === 0) throw new Error("Map step found no items (JSON array, one per line, or file:path).");
                            const itemTemplate = cleanText(node.config.itemTemplate) || "{{item}}";
                            const concurrency = cleanNumber(node.config.concurrency, 4, 1, 8);
                            const outs: { ok: boolean; text: string }[] = [];
                            for (let c = 0; c < items.length; c += concurrency) {
                                const chunk = await Promise.all(
                                    items.slice(c, c + concurrency).map(async (item, k) => {
                                        const i = c + k;
                                        const childInput = render(itemTemplate, { ...ctx, item, index: i + 1 });
                                        const childId = `${run.id}:${node.id}:${i}`.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 120);
                                        try {
                                            const text = await runChildPipeline(runtime as never, context, run, subDef, childInput, childId, `Queued by map ${node.id} (${i + 1}/${items.length}).`);
                                            return { ok: true as const, text };
                                        } catch (error) {
                                            return { ok: false as const, text: error instanceof Error ? error.message : String(error) };
                                        }
                                    }),
                                );
                                outs.push(...chunk);
                            }
                            const failed = outs.map((o, i) => ({ ...o, i })).filter((o) => !o.ok);
                            if (failed.length > 0 && cleanText(node.config.onError, 20) !== "continue") {
                                throw new Error(`${failed.length}/${outs.length} map items failed: ${failed.slice(0, 3).map((f) => `#${f.i + 1}: ${f.text}`).join("; ")}`);
                            }
                            const pairs = items.map((item, i) => ({ item, output: outs[i]?.ok === true ? (outs[i]?.text ?? "") : "", ...(outs[i]?.ok === false ? { error: outs[i]?.text ?? "" } : {}) }));
                            notes.push({ nodeId: node.id, text: `${labelOf(node)}: ${items.length} items → ${subDef.name}${failed.length > 0 ? ` (${failed.length} failed, kept going)` : ""}` });
                            out = JSON.stringify(pairs);
                        } else if (node.type === "merge") {
                            // Fan-in under a token budget: keep top items whole, summarize (or drop) the rest.
                            const toItem = (v: unknown): { text: string; score?: number }[] => {
                                if (typeof v === "string") {
                                    const t = v.trim();
                                    if (t.startsWith("[") || t.startsWith("{")) {
                                        try {
                                            const p: unknown = JSON.parse(t);
                                            return Array.isArray(p) ? p.flatMap(toItem) : toItem(p);
                                        } catch {
                                            /* not JSON: plain text */
                                        }
                                    }
                                    return [{ text: v }];
                                }
                                if (Array.isArray(v)) return v.flatMap(toItem);
                                if (v !== null && typeof v === "object") {
                                    const o = v as Record<string, unknown>;
                                    const text = typeof o.brief === "string" ? o.brief : typeof o.text === "string" ? o.text : typeof o.output === "string" ? o.output : JSON.stringify(v);
                                    const score = typeof o.score === "number" && Number.isFinite(o.score) ? o.score : undefined;
                                    return [{ text, ...(score === undefined ? {} : { score }) }];
                                }
                                return [{ text: String(v ?? "") }];
                            };
                            const items = active
                                .flatMap((n) => toItem(run.outputs[n.id] ?? ""))
                                .filter((i) => i.text.trim() !== "");
                            if (items.length === 0) throw new Error("Merge step has nothing to merge.");
                            const ranked = [...items].sort((a, b) => (b.score ?? Number.NEGATIVE_INFINITY) - (a.score ?? Number.NEGATIVE_INFINITY));
                            const budgetChars = cleanNumber(node.config.budget, 50000, 100, 500000) * 4 - 1500;
                            const keep = cleanNumber(node.config.keep, 10, 1, 100);
                            const kept: { text: string; score?: number }[] = [];
                            let used = 0;
                            for (const it of ranked.slice(0, keep)) {
                                if (used + it.text.length + 8 > budgetChars) break;
                                kept.push(it);
                                used += it.text.length + 8;
                            }
                            const rest = ranked.filter((r) => !kept.includes(r));
                            let extra = "";
                            let extraKind = "";
                            if (rest.length > 0) {
                                if (cleanText(node.config.strategy, 20) === "drop-rest") {
                                    extraKind = "dropped";
                                } else {
                                    const joined = rest.map((r) => r.text.slice(0, 4000)).join("\n\n---\n\n").slice(0, 60000);
                                    const called = await callModel(runtime as never, context as never, node, `Summarize each of the following briefs in 2-3 sentences, keeping every claim, number, and cited source. One paragraph per brief:\n\n${joined}`, "You compress research briefs without losing facts.");
                                    if (called.usage !== undefined && called.modelKey !== undefined) {
                                        usages.push({ key: called.modelKey, usage: called.usage as never });
                                    }
                                    extra = called.text;
                                    extraKind = "summarized";
                                }
                            }
                            out = [...kept.map((k) => k.text), ...(extra !== "" ? [`## Also ran (${rest.length} ${extraKind})\n${extra}`] : [])].join("\n\n---\n\n");
                            notes.push({ nodeId: node.id, text: `${labelOf(node)}: ${kept.length} full + ${rest.length > 0 ? `${rest.length} ${extraKind}` : "0 rest"} (~${Math.round((used + extra.length) / 4)}k tokens)` });
                        } else if (node.type === "write") {
                            const rel = cleanText(node.config.file, 500);
                            const text = render(cleanText(node.config.text, 200000) || "{{upstream}}", ctx);
                            const env = await runtime.env(context);
                            if (env === undefined) throw new Error("This session has no shell environment.");
                            const r = await env.writeFile(rel, text, context);
                            if (!r.ok) throw new Error(`Could not write ${rel}: ${(r.error as { message: string }).message}`);
                            const bytes = Buffer.byteLength(text, "utf8");
                            fileNotes.push({ nodeId: node.id, path: rel, bytes, label: labelOf(node) });
                            out = rel;
                        } else if (node.type === "read") {
                            const rel = cleanText(node.config.file, 500);
                            const env = await runtime.env(context);
                            if (env === undefined) throw new Error("This session has no shell environment.");
                            const r = await env.readTextFile(rel, context);
                            if (!r.ok) throw new Error(`Could not read ${rel}: ${(r.error as { message: string }).message}`);
                            const text = r.value ?? "";
                            if (text.length > 100_000) {
                                notes.push({ nodeId: node.id, text: `${labelOf(node)}: ${rel} truncated to 100k chars` });
                            }
                            out = text.slice(0, 100_000);
                        } else if (node.type === "fetch") {
                            // Public pages via Pi Pocket's SSRF-safe fetcher: no key, no quota.
                            // JS-walled pages come back thin and are flagged, not silently kept.
                            if (typeof host.fetchPublic !== "function") {
                                throw new Error("Fetch steps need Pi Pocket 0.20.0 or newer.");
                            }
                            const url = (render(cleanText(node.config.template) || "{{upstream}}", ctx).trim().split(/\s+/)[0] ?? "");
                            if (url === "") throw new Error("Fetch step has no URL.");
                            let res: Response;
                            try {
                                res = await host.fetchPublic(url, {
                                    headers: { accept: "text/html, text/plain;q=0.9, */*;q=0.1" },
                                    maxBytes: 5_000_000,
                                    timeoutMs: 30_000,
                                });
                            } catch (error) {
                                throw new Error(`Fetch failed for ${url}: ${error instanceof Error ? error.message : String(error)}`);
                            }
                            if (!res.ok) throw new Error(`Fetch ${res.status} for ${url}.`);
                            const contentType = res.headers.get("content-type") ?? "";
                            const body = await res.text();
                            const looksHtml = /html/i.test(contentType) || /<\s*(html|body)[\s>]/i.test(body.slice(0, 2000));
                            const text = looksHtml ? pageText(body) : body;
                            const maxChars = cleanNumber(node.config.maxChars, 20000, 100, 100000);
                            out = text.slice(0, maxChars);
                            if (out.trim().length < 500) {
                                notes.push({ nodeId: node.id, text: `${labelOf(node)}: thin page (${out.trim().length} chars) — may need JS rendering` });
                            }
                        }
                        await memo.memo(memoKey, out, context);
                        return out;
                    }),
                );

                const softFails = new Map<string, string>();
                let failure: { reason: unknown } | undefined;
                ready.forEach((node, i) => {
                    const result = results[i]!;
                    if (result.status !== "rejected") return;
                    const message = result.reason instanceof Error ? result.reason.message : String(result.reason);
                    if (cleanText(node.config.onError, 20) === "continue") softFails.set(node.id, message);
                    else if (failure === undefined) failure = { reason: result.reason };
                });

                await runtime.commit(async (tx) => {
                    const doc = await tx.doc(RunsDoc);
                    const item = doc.items[task.input.runId];
                    if (item === undefined) {
                        return { status: "terminal", outcome: { status: "completed", result: null } } as const;
                    }
                    if (item.stopRequested === true) {
                        item.status = "stopped";
                        item.current = [];
                        item.endedAt = Date.now();
                        item.log = [...item.log, { at: Date.now(), text: "Stopped." }].slice(-100);
                        return { status: "terminal", outcome: { status: "aborted", reason: "stopped" } } as const;
                    }
                    item.skipped = [...skipped];
                    item.steps += 1;
                    item.startedAt ??= Date.now();
                    item.visits = item.visits ?? {};
                    ready.forEach((node, i) => {
                        const result = results[i]!;
                        if (result.status === "fulfilled") {
                            item.outputs[node.id] = result.value.slice(0, 50_000);
                            item.visits![node.id] = (item.visits![node.id] ?? 0) + 1;
                            const extra = notes.find((n) => n.nodeId === node.id);
                            item.log = [
                                ...item.log,
                                { at: Date.now(), node: node.id, text: extra ? extra.text : `${labelOf(node)} done (${result.value.length} chars)` },
                            ].slice(-100);
                        } else if (softFails.has(node.id)) {
                            item.outputs[node.id] = "";
                            item.visits![node.id] = (item.visits![node.id] ?? 0) + 1;
                            item.failedNodes = { ...(item.failedNodes ?? {}), [node.id]: softFails.get(node.id)!.slice(0, 1000) };
                            item.log = [
                                ...item.log,
                                { at: Date.now(), node: node.id, text: `${labelOf(node)} failed, continuing without it: ${softFails.get(node.id)}` },
                            ].slice(-100);
                        }
                    });
                    for (const f of fileNotes) {
                        item.files = [...(item.files ?? []).filter((x) => x.path !== f.path), { ...f, at: Date.now() }].slice(-200);
                        item.log = [...item.log, { at: Date.now(), node: f.nodeId, text: `${f.label}: wrote ${f.path} (${f.bytes} bytes)` }].slice(-100);
                    }
                    // Loop-back: a finished node whose output matches an edge into an already-finished node
                    // sends that target (and everything downstream of it) back for another round, with the
                    // edge's note appended to the target's upstream. Visit caps stop runaway loops.
                    const requeue = new Map<string, string>();
                    ready.forEach((node, i) => {
                        const result = results[i]!;
                        if (result.status !== "fulfilled") return;
                        for (const e of graph.edges.filter((x) => x.from === node.id && x.when !== undefined && x.when !== "")) {
                            if (result.value === e.when && Object.hasOwn(item.outputs, e.to) && !requeue.has(e.to)) {
                                requeue.set(e.to, cleanText((e as { note?: unknown }).note, 2000));
                            }
                        }
                    });
                    for (const [target, note] of requeue) {
                        const targetNode = graph.nodes.find((n) => n.id === target);
                        const max = targetNode === undefined ? 3 : cleanNumber(targetNode.config.maxVisits, 3, 1, 10);
                        const visits = item.visits?.[target] ?? 0;
                        if (visits >= max) {
                            item.status = "failed";
                            item.error = `${labelOf(targetNode ?? { id: target, type: "", x: 0, y: 0, config: {} } as PipeNode)} looped back ${visits} times (cap ${max}). Fix the loop condition.`;
                            item.current = [];
                            item.endedAt = Date.now();
                            item.log = [...item.log, { at: Date.now(), text: `Failed: ${item.error}` }].slice(-100);
                            return {
                                status: "terminal",
                                outcome: { status: "failed", error: { message: (item.error ?? "loop cap").slice(0, 500) } },
                            } as const;
                        }
                        const closure = new Set<string>([target]);
                        let grew = true;
                        while (grew) {
                            grew = false;
                            for (const e of graph.edges) {
                                if (closure.has(e.from) && !closure.has(e.to)) {
                                    closure.add(e.to);
                                    grew = true;
                                }
                            }
                        }
                        for (const id of closure) {
                            delete item.outputs[id];
                            if (item.failedNodes !== undefined) delete item.failedNodes[id];
                        }
                        item.skipped = item.skipped.filter((id) => !closure.has(id));
                        if (note !== "") {
                            item.loopNotes = { ...(item.loopNotes ?? {}), [target]: note };
                        }
                        item.log = [...item.log, { at: Date.now(), node: target, text: `Looping back to ${labelOf(targetNode ?? { id: target, config: {} } as PipeNode)} (attempt ${visits + 1}).` }].slice(-100);
                    }
                    if (usages.length > 0) {
                        const usageDoc = (await tx.doc(UsageDoc, runtime.conversationId)) as unknown as {
                            models: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number; cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number } }>;
                        };
                        for (const { key, usage } of usages) {
                            const u = usage as { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number; cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number } };
                            usageDoc.models[key] ??= {
                                input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
                                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                            };
                            const total = usageDoc.models[key]!;
                            total.input += u.input; total.output += u.output;
                            total.cacheRead += u.cacheRead; total.cacheWrite += u.cacheWrite;
                            total.totalTokens += u.totalTokens;
                            for (const k of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) {
                                total.cost[k] += u.cost[k];
                            }
                        }
                    }
                    if (failure !== undefined) {
                        const message = failure.reason instanceof Error ? failure.reason.message : String(failure.reason);
                        item.status = "failed";
                        item.error = message.slice(0, 2000);
                        item.current = [];
                        item.endedAt = Date.now();
                        item.log = [...item.log, { at: Date.now(), text: `Failed: ${message}` }].slice(-100);
                        return {
                            status: "terminal",
                            outcome: { status: "failed", error: { message: message.slice(0, 500) } },
                        } as const;
                    }
                    item.status = "running";
                    item.current = [];
                    return { status: "running", checkpoint: { phase: "step", step: task.state.checkpoint.step + 1 } } as const;
                }, context);
                web.send("run", { ...(await runtime.snapshot(RunsDoc, context))?.items[task.input.runId] });
            },
        },
        abort: async (task, runtime, context) => {
            await runtime.commit(async (tx) => {
                const doc = await tx.doc(RunsDoc);
                const item = doc.items[task.input.runId];
                if (item !== undefined && item.status !== "done" && item.status !== "failed") {
                    item.status = "stopped";
                    item.current = [];
                    item.endedAt = Date.now();
                }
                return { status: "terminal", outcome: { status: "aborted", reason: "stopped" } } as const;
            }, context);
        },
    });

    return RunTaskDef;
}

// ─── Module ──────────────────────────────────────────────────────────────────

export default function createPipelines(host: Host, web: Web) {
    const creds = makeCredentials(host, web);
    const RunTask = runTaskFor(host, web, creds);

    if (typeof web.settings === "function") {
        web.settings([
            {
                name: "jevKey",
                label: "Jev API key (typesafe.ai)",
                type: "text",
                secret: true,
                description: "Direct Jev access for Decision steps. Server-only: never sent to the browser.",
            },
            {
                name: "openrouterKey",
                label: "OpenRouter API key",
                type: "text",
                secret: true,
                description: "Jev through OpenRouter for Decision steps. Server-only: never sent to the browser.",
            },
            {
                name: "openaiKey",
                label: "OpenAI API key",
                type: "text",
                secret: true,
                description: "OpenAI Decisions API for Decision steps. Server-only: never sent to the browser.",
            },
        ]);
    }

/** Run parameters from a person or Pi: small strings templates read as {{param:name}}. */
function sanitizeParams(raw: unknown): Record<string, string> {
    const out: Record<string, string> = {};
    const obj = typeof raw === "string" ? (() => { try { return JSON.parse(raw) as unknown; } catch { return undefined; } })() : raw;
    if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
        if (raw !== undefined && raw !== "" && obj === undefined) throw new Error("params must be a JSON object of strings.");
        return out;
    }
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
        if (Object.keys(out).length >= 50) break;
        if (/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(k) && (typeof v === "string" || typeof v === "number")) {
            out[k] = String(v).slice(0, 2000);
        }
    }
    return out;
}

    const startRun = async (
        commit: <T>(change: (tx: never) => T | Promise<T>) => Promise<T>,
        def: PipeDef,
        input: string,
        conversationId: number,
        by: string | undefined,
        runId: string,
        depth = 0,
        parentRunId?: string,
        params: Record<string, string> = {},
    ): Promise<PipeRun> =>
        commit(async (tx) => {
            const t = tx as unknown as {
                doc: (token: never, id?: never) => Promise<{ items: Record<string, PipeRun> }>;
                createTask: (task: never, input: never, options: never) => Promise<number>;
            };
            const doc = await t.doc(RunsDoc as never);
            const existing = doc.items[runId];
            if (existing !== undefined && existing.taskId !== undefined) return existing;
            const run: PipeRun = {
                id: runId,
                pipelineId: def.id,
                name: def.name,
                graph: JSON.parse(JSON.stringify(def.graph)) as PipeGraph,
                input: input.slice(0, 20_000),
                conversationId,
                status: "queued",
                outputs: {},
                skipped: [],
                current: [],
                steps: 0,
                log: [{ at: Date.now(), text: "Queued." }],
                params,
                depth,
                ...(parentRunId === undefined ? {} : { parentRunId }),
                createdAt: Date.now(),
                ...(by === undefined ? {} : { by }),
            };
            doc.items[runId] = run;
            run.taskId = await t.createTask(RunTask as never, { runId } as never, {
                ownership: { kind: "conversation" },
                conversationId,
                background: true,
            } as never);
            return run;
        });

    const findDef = (defs: { items: Record<string, PipeDef> }, nameOrId: string): PipeDef | undefined =>
        defs.items[nameOrId] ??
        Object.values(defs.items).find((d) => d.name.toLowerCase() === nameOrId.toLowerCase());

    // Routes for the visual editor (owner only, the default).
    web.route("GET", "defs", async ({ snapshot, context }) => {
        const defs = await snapshot(DefsDoc, context);
        return { items: Object.values(defs?.items ?? {}).sort((a, b) => a.updatedAt - b.updatedAt) };
    });
    web.route("POST", "defs", async ({ body, commit }) => {
        const name = cleanText(body.name, 120).trim();
        if (name === "") throw web.error(400, "Give the pipeline a name.");
        let graph: PipeGraph;
        try {
            graph = sanitizeGraph(body.graph);
        } catch (error) {
            throw web.error(400, error instanceof Error ? error.message : String(error));
        }
        const def = await commit(async (tx) => {
            const doc = await tx.doc(DefsDoc);
            const id = cleanText(body.id, 80) || randomUUID();
            const now = Date.now();
            const item: PipeDef = {
                id,
                name,
                graph,
                createdAt: doc.items[id]?.createdAt ?? now,
                updatedAt: now,
            };
            doc.items[id] = item;
            return item;
        });
        web.send("defs", def);
        return def;
    });
    web.route("POST", "defs/delete", async ({ body, commit }) => {
        const id = cleanText(body.id, 80);
        await commit(async (tx) => {
            const doc = await tx.doc(DefsDoc);
            delete doc.items[id];
        });
        return {};
    });
    web.route("GET", "runs", async ({ snapshot, context }) => {
        const runs = await snapshot(RunsDoc, context);
        return {
            items: Object.values(runs?.items ?? {})
                .sort((a, b) => b.createdAt - a.createdAt)
                .slice(0, 50),
        };
    });
    web.route("GET", "sessions", ({ sessions }) => ({ items: sessions() }));
    web.route("GET", "meta", () => {
        return {
            models: typeof host.subagentModels === "function" ? host.subagentModels() : [],
            thinkingLevels: host.thinkingLevels ?? [],
            keys: {
                jev: creds.hasKey("jev"),
                openrouter: creds.hasKey("openrouter"),
                openai: creds.hasKey("openai"),
            },
        };
    });
    web.route("POST", "runs/stop", async ({ body, commit }) => {
        const id = cleanText(body.runId, 120);
        await commit(async (tx) => {
            const doc = await tx.doc(RunsDoc);
            const item = doc.items[id];
            if (item !== undefined && (item.status === "queued" || item.status === "running")) {
                item.stopRequested = true;
            }
        });
        return {};
    });

    if (typeof web.conversationRoute === "function") {
        web.conversationRoute(
            "POST",
            "runs/:source",
            async (request) => {
                const defId = cleanText(request.body.pipelineId, 80);
                const defs = await request.snapshot(DefsDoc, request.context);
                const def = defs === undefined ? undefined : findDef(defs, defId);
                if (def === undefined) throw web.error(404, "No such pipeline.");
                try {
                    sanitizeGraph(def.graph);
                } catch (error) {
                    throw web.error(400, error instanceof Error ? error.message : String(error));
                }
                const run = await startRun(
                    request.commit as never,
                    def,
                    cleanText(request.body.input),
                    request.conversation.id as unknown as number,
                    request.user.id,
                    randomUUID(),
                    0,
                    undefined,
                    sanitizeParams(request.body.params),
                );
                web.send("run", run);
                return run;
            },
            { conversation: "source" },
        );
    }

    web.client("pipelines");

    // Tools for Pi.
    const pipeList = defineTool({
        name: "pipe_list",
        description: "List saved pipelines and recent pipeline runs (id, name, status).",
        parameters: Type.Object({}),
        replay: "safe",
        execute: async (_args, api, context) => {
            const defs = await api.snapshot(DefsDoc, context);
            const runs = await api.snapshot(RunsDoc, context);
            const lines = [
                "Pipelines:",
                ...Object.values(defs?.items ?? {}).map(
                    (d) => `- ${d.id} · ${d.name} · ${d.graph.nodes.length} nodes`,
                ),
                "Recent runs:",
                ...Object.values(runs?.items ?? {})
                    .sort((a, b) => b.createdAt - a.createdAt)
                    .slice(0, 10)
                    .map((r) => `- ${r.id} · ${r.name} · ${r.status}${r.error ? ` · ${r.error}` : ""}`),
            ];
            return { output: [{ type: "text" as const, text: lines.join("\n") }] };
        },
    });

    const pipePut = defineTool({
        name: "pipe_put",
        description:
            'Create or replace a pipeline from graph JSON: {"nodes":[{"id":"in","type":"input","x":80,"y":80,"config":{"label":"Input"}},{"id":"llm1","type":"llm","x":320,"y":80,"config":{"label":"Answer","prompt":"{{upstream}}"}}],"edges":[{"id":"e1","from":"in","to":"llm1"}]}. Types: input, llm (config prompt/system/model), agent (config prompt/system-as-instructions/model/thinking; a real Pi sub-session with tools, its own transcript), prompt (config text), bash (config command/timeout; runs shell commands on the server), code (config code/timeout; JavaScript in a sandbox with input/upstream/outputs globals, no tools), branch (config template/mode/value; edges from it may set "when":"true"/"false"), decision (config provider=jev|openrouter|openai default jev, kind=choice|noul|score, instructions, categories as "name: when it applies" lines for choice / "label: description" levels for score, model default per provider, minConfidence 0-100, threshold 0-100 for noul, cut level-index for score; keys from Pipelines settings, Secrets catalog, or TYPESAFE_API_KEY/OPENROUTER_API_KEY/OPENAI_API_KEY; outputs winning category, true/false, high/low, or unsure; route with edge when set to the category name, true/false, high/low, or unsure), refine (config prompt/times/until/model; repeats an LLM call, {{prev}} is the last round, stops early on until), map (config pipeline = sub-pipeline id or name, list = JSON array or one item per line or file:path or folder:path of .txt files, itemTemplate default {{item}}, maxItems default 30, concurrency default 4; runs the pipeline once per item with {{item}} and {{index}} available; outputs a JSON array of {item, output}), merge (config budget tokens default 50000, keep default 10, strategy=summarize-rest|drop-rest; keeps top briefs whole, summarizes or drops the rest; items with numeric score rank first), write (config file relative path, text; writes to the run folder and is tracked in the run), read (config file; outputs the file text), fetch (config template = URL; SSRF-safe fetch with HTML stripped, warns on thin pages), approval (config title/text/askInput/onDecline; pauses and asks a person in the run session), subpipe (config pipeline = pipeline id or name, text = its input), output (config text). Templates use {{input}}, {{upstream}}, {{Node label}}, {{node-id}}, {{param:name}} (run parameters), and {{item}}/{{index}} in map child inputs. Edges set "when" to route: true/false (branch, yes-no), category names or unsure (decision choice), high/low (decision score), or anything a node outputs. A when-edge into an already-finished node loops back and re-runs it (with the edge note appended); nodes re-run at most maxVisits times (default 3).',
        parameters: Type.Object({
            name: Type.String({ description: "The pipeline's name. Same name replaces it." }),
            graphJson: Type.String({ description: "The graph as JSON, as in the description." }),
        }),
        replay: "safe",
        execute: async (args, api, context) => {
            let parsed: unknown;
            try {
                parsed = JSON.parse(args.graphJson);
            } catch {
                throw new Error("graphJson is not valid JSON.");
            }
            const graph = sanitizeGraph(parsed);
            const def = await api.commit(async (tx) => {
                const doc = await tx.doc(DefsDoc);
                const found = Object.values(doc.items).find(
                    (d) => d.name.toLowerCase() === args.name.trim().toLowerCase(),
                );
                const now = Date.now();
                const item: PipeDef = {
                    id: found?.id ?? randomUUID(),
                    name: args.name.trim().slice(0, 120),
                    graph,
                    createdAt: found?.createdAt ?? now,
                    updatedAt: now,
                };
                doc.items[item.id] = item;
                return item;
            }, context);
            web.send("defs", def);
            return {
                output: [
                    { type: "text" as const, text: `Saved pipeline ${def.name} (${def.id}) with ${graph.nodes.length} nodes.` },
                ],
            };
        },
    });

    const pipeGet = defineTool({
        name: "pipe_get",
        description: "Get one pipeline's graph JSON by its id or name (see pipe_list).",
        parameters: Type.Object({ pipeline: Type.String() }),
        replay: "safe",
        execute: async (args, api, context) => {
            const defs = await api.snapshot(DefsDoc, context);
            const def = defs === undefined ? undefined : findDef(defs, args.pipeline);
            if (def === undefined) throw new Error(`No pipeline ${args.pipeline}. Use pipe_list.`);
            return { output: [{ type: "text" as const, text: JSON.stringify(def.graph, null, 2) }] };
        },
    });

    const pipeRun = defineTool({
        name: "pipe_run",
        description:
            "Run a saved pipeline (by id or name) with an input text, in this session. Optional paramsJson sets run parameters templates read as {{param:name}}. The run is durable: it checkpoints after each batch of nodes and resumes after a restart. Returns the run id; check it with pipe_status. Shell nodes run shell commands on the server.",
        parameters: Type.Object({
            pipeline: Type.String(),
            input: Type.String(),
            paramsJson: Type.Optional(Type.String({ description: "Optional JSON object of run parameters, e.g. {\"depth\":\"deep\",\"breadth\":\"5\"}." })),
        }),
        replay: "safe",
        execute: async (args, api, context) => {
            const defs = await api.snapshot(DefsDoc, context);
            const def = defs === undefined ? undefined : findDef(defs, args.pipeline);
            if (def === undefined) throw new Error(`No pipeline ${args.pipeline}. Use pipe_list.`);
            const runId = `run-${String(api.taskId)}-${api.callId}`.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 120);
            const run = await startRun(
                ((change: never) => api.commit(change, context)) as never,
                def,
                args.input,
                api.conversationId as unknown as number,
                undefined,
                runId,
                0,
                undefined,
                sanitizeParams(args.paramsJson),
            );
            web.send("run", run);
            return {
                output: [
                    {
                        type: "text" as const,
                        text: `Started run ${run.id} of ${def.name}. It runs in the background and survives restarts; check pipe_status with this run id.`,
                    },
                ],
            };
        },
    });

    const pipeStatus = defineTool({
        name: "pipe_status",
        description: "Show one pipeline run: its status, each finished node's output, and its log. Without runId, list recent runs.",
        parameters: Type.Object({ runId: Type.Optional(Type.String()) }),
        replay: "safe",
        execute: async (args, api, context) => {
            const runs = await api.snapshot(RunsDoc, context);
            const items = Object.values(runs?.items ?? {}).sort((a, b) => b.createdAt - a.createdAt);
            if (args.runId === undefined) {
                return {
                    output: [
                        {
                            type: "text" as const,
                            text: items.slice(0, 10).map((r) => `${r.id} · ${r.name} · ${r.status}`).join("\n") || "No runs yet.",
                        },
                    ],
                };
            }
            const run = items.find((r) => r.id === args.runId);
            if (run === undefined) throw new Error(`No run ${args.runId}.`);
            const lines = [
                `${run.name} · ${run.status}${run.error ? ` · ${run.error}` : ""}`,
                ...Object.entries(run.outputs).map(([id, text]) => `\n[${id}]\n${text.slice(0, 4000)}`),
                ...(Object.keys(run.failedNodes ?? {}).length > 0
                    ? [`\nFailed but continued: ${Object.entries(run.failedNodes ?? {}).map(([id, e]) => `${id} (${e})`).join("; ")}`]
                    : []),
                ...(run.skipped.length > 0 ? [`\nSkipped: ${run.skipped.join(", ")}`] : []),
                ...((run.files ?? []).length > 0
                    ? [`\nFiles:\n${(run.files ?? []).map((f) => `- ${f.path} (${f.bytes} bytes, by ${f.label})`).join("\n")}`]
                    : []),
                "\nLog:",
                ...run.log.slice(-20).map((l) => `- ${l.text}`),
            ];
            return { output: [{ type: "text" as const, text: lines.join("\n") }] };
        },
    });

    const pipeStop = defineTool({
        name: "pipe_stop",
        description: "Stop a pipeline run at its next node boundary.",
        parameters: Type.Object({ runId: Type.String() }),
        replay: "safe",
        execute: async (args, api, context) => {
            await api.commit(async (tx) => {
                const doc = await tx.doc(RunsDoc);
                const item = doc.items[args.runId];
                if (item !== undefined && (item.status === "queued" || item.status === "running")) {
                    item.stopRequested = true;
                }
            }, context);
            return { output: [{ type: "text" as const, text: `Stop requested for ${args.runId}.` }] };
        },
    });

    return defineExtension({
        name: "pipelines",
        tasks: [RunTask],
        tools: [pipeList, pipePut, pipeGet, pipeRun, pipeStatus, pipeStop],
    });
}
