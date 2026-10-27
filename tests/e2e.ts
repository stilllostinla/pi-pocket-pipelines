// End-to-end runner tests on an in-memory Harness with a fake model. No network, no real provider.
//
// Run from the pipelines-next folder (its node_modules symlink points at Pi Pocket's packages):
//   node --experimental-strip-types tests/e2e.ts
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import createPipelines from "../pipelines.ts";

const context = BACKGROUND_CONTEXT;
const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
faux.setResponses(
    Array.from({ length: 60 }, () => (ctx: { messages: readonly { role: string; content: unknown }[] }) => {
        const last = [...ctx.messages].reverse().find((m) => m.role === "user");
        const text =
            typeof last?.content === "string"
                ? last.content
                : ((last?.content as { type: string; text?: string }[]) ?? [])
                      .filter((c) => c.type === "text")
                      .map((c) => c.text ?? "")
                      .join("");
        return fauxAssistantMessage(`LLM[${text.slice(0, 80)}]`);
    }),
);
const models = createModels();
models.setProvider(faux.provider);
const registry = createRegistry();
let askAnswer: unknown = { answered: true, by: "Tester", values: {} };
const host = {
    subagentModels: () => [],
    heldBack: () => undefined,
    thinkingLevels: ["off", "low", "high"],
    ask: async () => askAnswer,
} as never;
const web = {
    route: () => {},
    conversationRoute: () => {},
    client: () => {},
    send: () => {},
    error: (s: number, m: string) => Object.assign(new Error(m), { status: s }),
    onDispose: () => {},
} as never;
const ext = createPipelines(host, web) as unknown as {
    tools: { name: string; execute: (args: never, api: never, ctx: never) => Promise<{ output: { text: string }[] }> }[];
};
registry.install(ext as never);

const harness = await Harness.open(
    new MemoryStorage(),
    { models, registry, env: ({ cwd }: { cwd?: string }) => new NodeExecutionEnv({ cwd: cwd ?? process.cwd() }) } as never,
    context,
);
const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } } as never);
harness.resume();

const api = (taskId: number, callId: string) =>
    ({
        taskId,
        callId,
        conversationId: root.id,
        snapshot: (doc: never, ctx: never) => harness.snapshot(doc, ctx),
        commit: (fn: never, ctx: never) => harness.commit(fn, ctx),
        agent: async () => ({ model: { provider: "faux", modelId: "faux-1" } }),
        models,
    }) as never;
const tool = (name: string) => ext.tools.find((t) => t.name === name)!;
const fails: string[] = [];
const check = (name: string, cond: boolean) => {
    console.log((cond ? "PASS " : "FAIL ") + name);
    if (!cond) fails.push(name);
};
let seq = 0;
async function put(name: string, graph: unknown) {
    seq++;
    await tool("pipe_put").execute({ name, graphJson: JSON.stringify(graph) } as never, api(seq, `p${seq}`), context as never);
}
async function runPipe(name: string, input: string): Promise<string> {
    seq++;
    const started = (await tool("pipe_run").execute({ pipeline: name, input } as never, api(seq, `r${seq}`), context as never)).output[0]!.text;
    const runId = started.match(/run \S+/)?.[0].slice(4) ?? "";
    let status = "";
    for (let i = 0; i < 80; i++) {
        await new Promise((r) => setTimeout(r, 400));
        seq++;
        status = (await tool("pipe_status").execute({ runId } as never, api(seq, `s${seq}`), context as never)).output[0]!.text;
        if (status.includes("· done") || status.includes("· failed")) break;
    }
    return status;
}

// 1. Fan-out / fan-in / branch / skip
await put("FanPipe", {
    nodes: [
        { id: "in", type: "input", x: 0, y: 0, config: { label: "Input" } },
        { id: "p", type: "prompt", x: 0, y: 0, config: { label: "Prep", text: "Say: {{input}}" } },
        { id: "a", type: "llm", x: 0, y: 0, config: { label: "Alpha", prompt: "A: {{upstream}}" } },
        { id: "b", type: "llm", x: 0, y: 0, config: { label: "Beta", prompt: "B: {{upstream}}" } },
        { id: "join", type: "prompt", x: 0, y: 0, config: { label: "Join", text: "{{Alpha}} + {{Beta}}" } },
        { id: "br", type: "branch", x: 0, y: 0, config: { label: "Branch", template: "{{upstream}}", mode: "contains", value: "LLM[" } },
        { id: "out", type: "output", x: 0, y: 0, config: { label: "Output", text: "FINAL {{upstream}}" } },
        { id: "bad", type: "bash", x: 0, y: 0, config: { label: "WrongPath", command: "echo SHOULD_NOT_RUN" } },
    ],
    edges: [
        { id: "e1", from: "in", to: "p" }, { id: "e2", from: "p", to: "a" }, { id: "e3", from: "p", to: "b" },
        { id: "e4", from: "a", to: "join" }, { id: "e5", from: "b", to: "join" }, { id: "e6", from: "join", to: "br" },
        { id: "e7", from: "br", to: "out", when: "true" }, { id: "e8", from: "br", to: "bad", when: "false" },
    ],
});
const fan = await runPipe("FanPipe", "hello world");
check("fan-out/fan-in/branch run done", fan.includes("· done"));
check("fan-in joined both LLMs", fan.includes("LLM[A:") && fan.includes("LLM[B:"));
check("branch false path skipped", fan.includes("Skipped: bad"));

// 2. Shell + loop + code
await put("ShellLoop", {
    nodes: [
        { id: "in", type: "input", x: 0, y: 0, config: { label: "Input" } },
        { id: "sh", type: "bash", x: 0, y: 0, config: { label: "Shell", command: "echo hi {{input}}" } },
        { id: "lp", type: "loop", x: 0, y: 0, config: { label: "Loop", prompt: "Round {{index}}: {{prev}}", times: 2 } },
        { id: "cd", type: "code", x: 0, y: 0, config: { label: "Code", code: "return upstream + ' [coded]';" } },
        { id: "out", type: "output", x: 0, y: 0, config: { label: "Output", text: "{{Shell}} | {{Loop}} | {{Code}}" } },
    ],
    edges: [
        { id: "f1", from: "in", to: "sh" }, { id: "f2", from: "sh", to: "lp" },
        { id: "f3", from: "lp", to: "cd" }, { id: "f4", from: "cd", to: "out" }, { id: "f5", from: "sh", to: "out" },
    ],
});
const shell = await runPipe("ShellLoop", "there");
check("shell+loop+code run done", shell.includes("· done"));
check("bash output flowed", shell.includes("hi there"));
check("loop iterated with prev/index", shell.includes("Round 2"));
check("code transformed", shell.includes("[coded]"));

// 3. Parallel agents (scouts) + join by label
await put("Scouts", {
    nodes: [
        { id: "in", type: "input", x: 0, y: 0, config: { label: "Input" } },
        { id: "sa", type: "agent", x: 0, y: 0, config: { label: "ScoutA", prompt: "Scout A on: {{upstream}}" } },
        { id: "sb", type: "agent", x: 0, y: 0, config: { label: "ScoutB", prompt: "Scout B on: {{upstream}}" } },
        { id: "join", type: "prompt", x: 0, y: 0, config: { label: "Join", text: "{{ScoutA}} || {{ScoutB}}" } },
        { id: "out", type: "output", x: 0, y: 0, config: { label: "Output", text: "{{upstream}}" } },
    ],
    edges: [
        { id: "g1", from: "in", to: "sa" }, { id: "g2", from: "in", to: "sb" },
        { id: "g3", from: "sa", to: "join" }, { id: "g4", from: "sb", to: "join" }, { id: "g5", from: "join", to: "out" },
    ],
});
const scouts = await runPipe("Scouts", "the topic");
check("parallel agents run done", scouts.includes("· done"));
check("both scouts answered", scouts.includes("LLM[Scout A on: the topic]") && scouts.includes("LLM[Scout B on: the topic]"));

// 4. Continue-on-error: a doomed LLM node must not sink the run
await put("Resilient", {
    nodes: [
        { id: "in", type: "input", x: 0, y: 0, config: { label: "Input" } },
        { id: "ok", type: "prompt", x: 0, y: 0, config: { label: "Good", text: "good:{{input}}" } },
        { id: "boom", type: "llm", x: 0, y: 0, config: { label: "Boom", prompt: "x", model: "bogus/nope", onError: "continue" } },
        { id: "out", type: "output", x: 0, y: 0, config: { label: "Output", text: "{{Good}}|{{Boom}}|" } },
    ],
    edges: [
        { id: "h1", from: "in", to: "ok" }, { id: "h2", from: "in", to: "boom" },
        { id: "h3", from: "ok", to: "out" }, { id: "h4", from: "boom", to: "out" },
    ],
});
const resilient = await runPipe("Resilient", "data");
check("continue-on-error run still done", resilient.includes("· done"));
check("failure recorded as continued", resilient.includes("Failed but continued"));
check("surviving output present", resilient.includes("good:data"));

// 5. Same failure without continue must fail the run
await put("Fragile", {
    nodes: [
        { id: "in", type: "input", x: 0, y: 0, config: { label: "Input" } },
        { id: "boom", type: "llm", x: 0, y: 0, config: { label: "Boom", prompt: "x", model: "bogus/nope" } },
        { id: "out", type: "output", x: 0, y: 0, config: { label: "Output", text: "{{upstream}}" } },
    ],
    edges: [{ id: "i1", from: "in", to: "boom" }, { id: "i2", from: "boom", to: "out" }],
});
const fragile = await runPipe("Fragile", "data");
check("hard failure fails the run", fragile.includes("· failed"));

// 6. Approval approve -> sub-pipeline; decline -> fail
await put("ChildPipe", {
    nodes: [
        { id: "in", type: "input", x: 0, y: 0, config: { label: "Input" } },
        { id: "p", type: "prompt", x: 0, y: 0, config: { label: "Prep", text: "child:{{input}}" } },
        { id: "out", type: "output", x: 0, y: 0, config: { label: "Output", text: "{{upstream}}" } },
    ],
    edges: [{ id: "j1", from: "in", to: "p" }, { id: "j2", from: "p", to: "out" }],
});
await put("MainPipe", {
    nodes: [
        { id: "in", type: "input", x: 0, y: 0, config: { label: "Input" } },
        { id: "ap", type: "approval", x: 0, y: 0, config: { label: "Approval", title: "Ship it?", text: "{{upstream}}", onDecline: "stop" } },
        { id: "sub", type: "subpipe", x: 0, y: 0, config: { label: "Sub", pipeline: "ChildPipe", text: "{{upstream}}" } },
        { id: "out", type: "output", x: 0, y: 0, config: { label: "Output", text: "DONE {{upstream}}" } },
    ],
    edges: [{ id: "k1", from: "in", to: "ap" }, { id: "k2", from: "ap", to: "sub" }, { id: "k3", from: "sub", to: "out" }],
});
askAnswer = { answered: true, by: "Tester", values: {} };
const main = await runPipe("MainPipe", "hello");
check("approval+subpipe run done", main.includes("· done"));
check("sub-pipeline output flowed", main.includes("DONE child:approved"));
askAnswer = { answered: false, by: "Tester" };
const declined = await runPipe("MainPipe", "again");
check("declined approval fails run", declined.includes("· failed") && declined.includes("declined"));

// 7. Decision (Jev Choice): stub the HTTP endpoint, no network.
delete process.env.TYPESAFE_API_KEY;
await put("NoKeyPipe", {
    nodes: [
        { id: "in", type: "input", x: 0, y: 0, config: { label: "Input" } },
        { id: "d", type: "decision", x: 0, y: 0, config: { label: "Route", kind: "choice", template: "{{upstream}}", instructions: "Which team?", categories: "billing: money\ntechnical: broken" } },
        { id: "out", type: "output", x: 0, y: 0, config: { label: "Output", text: "{{upstream}}" } },
    ],
    edges: [{ id: "m1", from: "in", to: "d" }, { id: "m2", from: "d", to: "out" }],
});
const noKey = await runPipe("NoKeyPipe", "charge twice");
check("decision without a key fails with guidance", noKey.includes("· failed") && noKey.includes("Jev API key"));

let jevCalls: unknown[] = [];
const jevQueue: unknown[] = [];
(globalThis as { fetch?: unknown }).fetch = async (url: unknown, init: { body?: string }) => {
    if (String(url) !== "https://api.typesafe.ai/v1/systemone") throw new Error(`unexpected fetch ${String(url)}`);
    jevCalls.push(JSON.parse(init.body ?? "{}"));
    const next = jevQueue.shift();
    return { ok: true, status: 200, json: async () => next, text: async () => JSON.stringify(next) };
};
process.env.TYPESAFE_API_KEY = "test-key";
const choiceAnswer = {
    model: "jev-latest",
    answers: { q: { type: "choice", choice: "billing", confidence: 0.8, probabilities: { billing: 0.8, technical: 0.2 } } },
    usage: { input_tokens: 50, output_tokens: 5 },
};
await put("ChoicePipe", {
    nodes: [
        { id: "in", type: "input", x: 0, y: 0, config: { label: "Input" } },
        { id: "d", type: "decision", x: 0, y: 0, config: { label: "Route", kind: "choice", template: "{{upstream}}", instructions: "Which team?", categories: "billing: money\ntechnical: broken", model: "jev-latest" } },
        { id: "bill", type: "output", x: 0, y: 0, config: { label: "Bill", text: "B:{{upstream}}" } },
        { id: "tech", type: "output", x: 0, y: 0, config: { label: "Tech", text: "T:{{upstream}}" } },
    ],
    edges: [
        { id: "m1", from: "in", to: "d" },
        { id: "m2", from: "d", to: "bill", when: "billing" },
        { id: "m3", from: "d", to: "tech", when: "technical" },
    ],
});
jevQueue.push(choiceAnswer);
const choice = await runPipe("ChoicePipe", "charge twice");
check("decision choice routes by winner", choice.includes("· done") && choice.includes("B:billing"));
check("losing category path skipped", choice.includes("Skipped: tech"));
check("jev got state+questions", (jevCalls[0] as { questions?: { q?: { type?: string; criteria?: object } } }).questions?.q?.type === "choice");
check("choice logged with confidence", choice.includes("billing (80%)"));

jevQueue.push(choiceAnswer);
await put("UnsurePipe", {
    nodes: [
        { id: "in", type: "input", x: 0, y: 0, config: { label: "Input" } },
        { id: "d", type: "decision", x: 0, y: 0, config: { label: "Route", kind: "choice", template: "{{upstream}}", instructions: "Which team?", categories: "billing: money\ntechnical: broken", minConfidence: 90 } },
        { id: "u", type: "output", x: 0, y: 0, config: { label: "Human", text: "H:{{upstream}}" } },
    ],
    edges: [{ id: "m1", from: "in", to: "d" }, { id: "m2", from: "d", to: "u", when: "unsure" }],
});
const unsure = await runPipe("UnsurePipe", "charge twice");
check("low confidence routes to unsure", unsure.includes("· done") && unsure.includes("H:unsure"));

jevQueue.push({ model: "jev-latest", answers: { q: { type: "noul", noul: 0.7 } }, usage: { input_tokens: 10, output_tokens: 1 } });
jevQueue.push({ model: "jev-latest", answers: { q: { type: "noul", noul: 0.2 } }, usage: { input_tokens: 10, output_tokens: 1 } });
await put("NoulPipe", {
    nodes: [
        { id: "in", type: "input", x: 0, y: 0, config: { label: "Input" } },
        { id: "y", type: "decision", x: 0, y: 0, config: { label: "Spam?", kind: "noul", template: "{{upstream}}", instructions: "Is this spam?", threshold: 50 } },
        { id: "n", type: "decision", x: 0, y: 0, config: { label: "Spam2?", kind: "noul", template: "{{upstream}}", instructions: "Is this spam?", threshold: 50 } },
        { id: "out", type: "output", x: 0, y: 0, config: { label: "Output", text: "{{Spam?}}/{{Spam2?}}" } },
    ],
    edges: [{ id: "m1", from: "in", to: "y" }, { id: "m2", from: "in", to: "n" }, { id: "m3", from: "y", to: "out" }, { id: "m4", from: "n", to: "out" }],
});
const noul = await runPipe("NoulPipe", "hello");
check("noul true/false by threshold", noul.includes("· done") && noul.includes("true/false"));

let threw = "";
try {
    await tool("pipe_put").execute({ name: "BadDecision", graphJson: JSON.stringify({
        nodes: [{ id: "d", type: "decision", x: 0, y: 0, config: { label: "Route", kind: "choice", instructions: "Pick.", categories: "" } }],
        edges: [],
    }) } as never, api(900, "bad") as never, context as never);
} catch (e) {
    threw = e instanceof Error ? e.message : String(e);
}
check("choice with no categories is refused", threw.includes("at least one category"));

console.log(fails.length ? `E2E-FAIL (${fails.length})` : "E2E-OK");
await harness.close(context);
process.exit(fails.length ? 1 : 0);
