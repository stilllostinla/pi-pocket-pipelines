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
 */
import { randomUUID } from "node:crypto";
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
type PipeEdge = { id: string; from: string; to: string; when?: string };
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

const NODE_TYPES = ["input", "llm", "agent", "prompt", "bash", "code", "branch", "decision", "loop", "approval", "subpipe", "output"];
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
        for (const key of ["prompt", "system", "text", "template", "command", "value", "until", "model", "code", "title", "thinking", "pipeline", "onDecline", "onError", "kind", "categories", "instructions", "provider"]) {
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
        if (configIn.times !== undefined) config.times = cleanNumber(configIn.times, 3, 1, 20);
        if (configIn.timeout !== undefined) config.timeout = cleanNumber(configIn.timeout, 120, 1, 600);
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
        edges.push({
            id: cleanText(edge.id, 80) || `e${edges.length + 1}`,
            from,
            to,
            ...(when === "" ? {} : { when }),
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

function hash(text: string): string {
    let h = 5381;
    for (let i = 0; i < text.length; i++) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0;
    return h.toString(36);
}

/** Fill {{input}}, {{upstream}}, {{Label}}, {{node-id}}, {{index}}, {{prev}} in a template. */
function render(
    template: string,
    ctx: { input: string; upstream: string; outputs: Map<string, string>; nodes: PipeNode[]; index?: number; prev?: string },
): string {
    return template.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_all, name: string) => {
        const key = name.trim();
        if (key === "input") return ctx.input;
        if (key === "upstream") return ctx.upstream;
        if (key === "prev" || key === "current") return ctx.prev ?? ctx.upstream;
        if (key === "index") return ctx.index === undefined ? "" : String(ctx.index);
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
): { active: PipeNode[]; settled: boolean } {
    const incoming = graph.edges.filter((e) => e.to === node.id);
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

function hasCycle(graph: PipeGraph): boolean {
    const indegree = new Map(graph.nodes.map((n) => [n.id, 0]));
    for (const e of graph.edges) indegree.set(e.to, (indegree.get(e.to) ?? 0) + 1);
    const queue = graph.nodes.filter((n) => (indegree.get(n.id) ?? 0) === 0).map((n) => n.id);
    let seen = 0;
    while (queue.length > 0) {
        const id = queue.shift()!;
        seen++;
        for (const e of graph.edges.filter((x) => x.from === id)) {
            const left = (indegree.get(e.to) ?? 0) - 1;
            indegree.set(e.to, left);
            if (left === 0) queue.push(e.to);
        }
    }
    return seen < graph.nodes.length;
}

const textOf = (reply: { content: readonly { type: string; text?: string }[] }): string =>
    reply.content.flatMap((part) => (part.type === "text" ? [part.text ?? ""] : [])).join("");

// ─── The durable run task ────────────────────────────────────────────────────

type RunInput = { runId: string };
type RunState = { phase: "step"; step: number };

function runTaskFor(host: Host, web: Web) {
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
    function credential(provider: "jev" | "openrouter" | "openai"): string {
        const fromSetting = (name: string) =>
            typeof web.setting === "function" ? cleanText(web.setting(name), 500).trim() : "";
        const env = (typeof process !== "undefined" ? process.env : {}) as Record<string, string | undefined>;
        if (provider === "jev") return fromSetting("jevKey") || (env.TYPESAFE_API_KEY ?? "").trim();
        if (provider === "openrouter") return fromSetting("openrouterKey") || (env.OPENROUTER_API_KEY ?? "").trim();
        return fromSetting("openaiKey") || (env.OPENAI_API_KEY ?? "").trim();
    }

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
    async function classifyDecision(node: PipeNode, stateText: string, runInput: string): Promise<Classified> {
        const provider = (cleanText(node.config.provider, 20) || "jev") as "jev" | "openrouter" | "openai";
        const key = credential(provider);
        if (key === "") {
            const hint =
                provider === "jev"
                    ? "TYPESAFE_API_KEY"
                    : provider === "openrouter"
                      ? "OPENROUTER_API_KEY"
                      : "OPENAI_API_KEY";
            throw new Error(
                `Decision steps on ${provider} need an API key: set it in Pipelines settings (Menu → Extensions → Pipelines), or ${hint} on the server.`,
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
                if (hasCycle(graph)) {
                    await fail("The graph has a cycle. Break the loop, or use a Loop node.");
                    return;
                }
                if (run.steps > 200) {
                    await fail("The run passed 200 steps and was stopped.");
                    return;
                }

                const outputsMap = new Map(Object.entries(run.outputs));
                const skipped = new Set(run.skipped);

                // Settle skips: a node whose inputs all settled but none is active (a branch went the other way).
                let changed = true;
                while (changed) {
                    changed = false;
                    for (const node of graph.nodes) {
                        if (outputsMap.has(node.id) || skipped.has(node.id)) continue;
                        const incoming = graph.edges.filter((e) => e.to === node.id);
                        if (incoming.length === 0) continue;
                        const { active, settled } = upstreamOf(node, graph, run.outputs, skipped);
                        if (settled && active.length === 0) {
                            skipped.add(node.id);
                            changed = true;
                        }
                    }
                }

                const ready = graph.nodes.filter((node) => {
                    if (outputsMap.has(node.id) || skipped.has(node.id)) return false;
                    const { active, settled } = upstreamOf(node, graph, run.outputs, skipped);
                    return settled && (graph.edges.every((e) => e.to !== node.id) || active.length > 0);
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
                const results = await Promise.allSettled(
                    ready.map(async (node) => {
                        const { active } = upstreamOf(node, graph, run.outputs, skipped);
                        const upstream = active.map((n) => run.outputs[n.id] ?? "").join("\n\n");
                        const ctx = { input: run.input, upstream, outputs: outputsMap, nodes: graph.nodes };
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
                            const decided = await classifyDecision(node, stateText, run.input);
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
                        } else if (node.type === "llm" || node.type === "loop") {
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
                            // The child run id is fixed, so a restart finds the same child instead of starting another.
                            const depth = run.depth ?? 0;
                            if (depth >= 3) throw new Error("Sub-pipelines nest at most 3 deep.");
                            const wanted = cleanText(node.config.pipeline, 200).trim();
                            if (wanted === "") throw new Error("Sub-pipeline node names no pipeline.");
                            const allDefs = await runtime.snapshot(DefsDoc, context);
                            const subDef =
                                allDefs?.items[wanted] ??
                                Object.values(allDefs?.items ?? {}).find((d) => d.name.toLowerCase() === wanted.toLowerCase());
                            if (subDef === undefined) throw new Error(`No pipeline ${wanted} for the sub-pipeline node.`);
                            const subInput = render(cleanText(node.config.text) || "{{upstream}}", ctx);
                            const subRunId = `${run.id}:${node.id}:sub`.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 120);
                            let subTaskId: number | undefined;
                            await runtime.commit(async (tx) => {
                                const doc = await tx.doc(RunsDoc);
                                const existing = doc.items[subRunId];
                                if (existing !== undefined && existing.taskId !== undefined) {
                                    subTaskId = existing.taskId;
                                    return undefined;
                                }
                                const childRun: PipeRun = {
                                    id: subRunId,
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
                                    log: [{ at: Date.now(), text: `Queued by ${run.id}.` }],
                                    depth: depth + 1,
                                    parentRunId: run.id,
                                    createdAt: Date.now(),
                                };
                                doc.items[subRunId] = childRun;
                                childRun.taskId = (await tx.createTask(RunTaskDef as never, { runId: subRunId } as never, {
                                    ownership: { kind: "task", taskId: runtime.taskId },
                                    conversationId: run.conversationId as never,
                                } as never)) as unknown as number;
                                subTaskId = childRun.taskId;
                                return undefined;
                            }, context);
                            const settledTask = await runtime.waitForTask(subTaskId as never, context);
                            const subRun = (await runtime.snapshot(RunsDoc, context))?.items[subRunId];
                            if ((settledTask as unknown as { state: { outcome?: { status: string } } }).state.outcome?.status !== "completed" || subRun?.status !== "done") {
                                throw new Error(`Sub-pipeline ${subDef.name} failed: ${subRun?.error ?? "see its run in the runs list"}`);
                            }
                            const outNodes = subDef.graph.nodes.filter((n) => n.type === "output");
                            const picked = (outNodes.length > 0 ? outNodes : subDef.graph.nodes)
                                .map((n) => subRun.outputs[n.id])
                                .filter((v): v is string => v !== undefined);
                            out = picked.join("\n\n");
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
                    ready.forEach((node, i) => {
                        const result = results[i]!;
                        if (result.status === "fulfilled") {
                            item.outputs[node.id] = result.value.slice(0, 50_000);
                            const extra = notes.find((n) => n.nodeId === node.id);
                            item.log = [
                                ...item.log,
                                { at: Date.now(), node: node.id, text: extra ? extra.text : `${labelOf(node)} done (${result.value.length} chars)` },
                            ].slice(-100);
                        } else if (softFails.has(node.id)) {
                            item.outputs[node.id] = "";
                            item.failedNodes = { ...(item.failedNodes ?? {}), [node.id]: softFails.get(node.id)!.slice(0, 1000) };
                            item.log = [
                                ...item.log,
                                { at: Date.now(), node: node.id, text: `${labelOf(node)} failed, continuing without it: ${softFails.get(node.id)}` },
                            ].slice(-100);
                        }
                    });
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
    const RunTask = runTaskFor(host, web);

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

    const startRun = async (
        commit: <T>(change: (tx: never) => T | Promise<T>) => Promise<T>,
        def: PipeDef,
        input: string,
        conversationId: number,
        by: string | undefined,
        runId: string,
        depth = 0,
        parentRunId?: string,
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
        const has = (name: string) => cleanText(typeof web.setting === "function" ? web.setting(name) : "", 500).trim() !== "";
        return {
            models: typeof host.subagentModels === "function" ? host.subagentModels() : [],
            thinkingLevels: host.thinkingLevels ?? [],
            keys: {
                jev: has("jevKey") || (process.env.TYPESAFE_API_KEY ?? "").trim() !== "",
                openrouter: has("openrouterKey") || (process.env.OPENROUTER_API_KEY ?? "").trim() !== "",
                openai: has("openaiKey") || (process.env.OPENAI_API_KEY ?? "").trim() !== "",
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
            'Create or replace a pipeline from graph JSON: {"nodes":[{"id":"in","type":"input","x":80,"y":80,"config":{"label":"Input"}},{"id":"llm1","type":"llm","x":320,"y":80,"config":{"label":"Answer","prompt":"{{upstream}}"}}],"edges":[{"id":"e1","from":"in","to":"llm1"}]}. Types: input, llm (config prompt/system/model), agent (config prompt/system-as-instructions/model/thinking; a real Pi sub-session with tools, its own transcript), prompt (config text), bash (config command/timeout; runs shell commands on the server), code (config code/timeout; JavaScript in a sandbox with input/upstream/outputs globals, no tools), branch (config template/mode/value; edges from it may set "when":"true"/"false"), decision (config provider=jev|openrouter|openai default jev, kind=choice|noul|score, instructions, categories as "name: when it applies" lines for choice / "label: description" levels for score, model default per provider, minConfidence 0-100, threshold 0-100 for noul, cut level-index for score; keys from Pipelines settings or TYPESAFE_API_KEY/OPENROUTER_API_KEY/OPENAI_API_KEY; outputs winning category, true/false, high/low, or unsure; route with edge when set to the category name, true/false, high/low, or unsure), loop (config prompt/times/until/model), approval (config title/text/askInput/onDecline; pauses and asks a person in the run session), subpipe (config pipeline = pipeline id or name, text = its input), output (config text). Templates use {{input}}, {{upstream}}, {{Node label}}, {{node-id}}.',
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
            "Run a saved pipeline (by id or name) with an input text, in this session. The run is durable: it checkpoints after each batch of nodes and resumes after a restart. Returns the run id; check it with pipe_status. Shell nodes run shell commands on the server.",
        parameters: Type.Object({
            pipeline: Type.String(),
            input: Type.String(),
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
