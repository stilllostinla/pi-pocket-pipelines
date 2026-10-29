// Pipelines: a visual workflow editor on the rail. Drag nodes, connect them, edit each step, save, and run.
// Graphs are saved on the server (durable); runs execute there and stream back with "run" events.

export const pocketApi = 1;

const FLOW = "M4 6h6l4 4-4 4H4zM14 10h6M10 18h10"; // simple flow-ish mark

const TYPES = [
    { type: "input", label: "Input", color: "#58a6ff" },
    { type: "llm", label: "LLM call", color: "#bc8cff" },
    { type: "agent", label: "Agent", color: "#d2a8ff" },
    { type: "prompt", label: "Prompt", color: "#7ee787" },
    { type: "bash", label: "Shell", color: "#ffa657" },
    { type: "code", label: "Code", color: "#a5d6ff" },
    { type: "branch", label: "Branch", color: "#f2cc60" },
    { type: "decision", label: "Decision", color: "#f778ba" },
    { type: "refine", label: "Refine", color: "#ff7b72" },
    { type: "map", label: "Map", color: "#4dd0e1" },
    { type: "merge", label: "Merge", color: "#69f0ae" },
    { type: "write", label: "Write file", color: "#bcaaa4" },
    { type: "read", label: "Read file", color: "#bcaaa4" },
    { type: "fetch", label: "Fetch URL", color: "#80cbc4" },
    { type: "approval", label: "Approval", color: "#ffcda3" },
    { type: "subpipe", label: "Sub-pipeline", color: "#56d4dd" },
    { type: "output", label: "Output", color: "#79c0ff" },
];
const colorOf = (t) => (TYPES.find((x) => x.type === t) || {}).color || "#888";
const labelOf = (n) => (n.config && n.config.label) || n.type;

let seq = 0;
const nid = (p) => `${p}${Date.now().toString(36)}${(seq++).toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;

function defaultNode(type, x, y) {
    const base = { id: nid("n"), type, x, y, config: { label: (TYPES.find((t) => t.type === type) || {}).label || type } };
    if (type === "llm") base.config = { label: "LLM call", system: "", prompt: "{{upstream}}", model: "" };
    if (type === "agent") base.config = { label: "Agent", system: "", prompt: "{{upstream}}", model: "", thinking: "session" };
    if (type === "code") base.config = { label: "Code", code: "return upstream.toUpperCase();", timeout: 10 };
    if (type === "approval") base.config = { label: "Approval", title: "Approve this step?", text: "{{upstream}}", askInput: false, onDecline: "stop" };
    if (type === "subpipe") base.config = { label: "Sub-pipeline", pipeline: "", text: "{{upstream}}" };
    if (type === "prompt") base.config = { label: "Prompt", text: "{{upstream}}" };
    if (type === "output") base.config = { label: "Output", text: "{{upstream}}" };
    if (type === "bash") base.config = { label: "Shell", command: "echo {{upstream}}", timeout: 120 };
    if (type === "branch") base.config = { label: "Branch", template: "{{upstream}}", mode: "contains", value: "yes" };
    if (type === "decision") base.config = { label: "Decision", provider: "jev", kind: "choice", template: "{{upstream}}", instructions: "", categories: "billing: payment or subscription issues\ntechnical: the product is broken or unusable\nsales: wants pricing or a demo", model: "", threshold: 50, minConfidence: 0, cut: "" };
    if (type === "refine") base.config = { label: "Refine", system: "", prompt: "Improve this:\n{{prev}}", times: 3, until: "", model: "" };
    if (type === "map") base.config = { label: "Map", pipeline: "", list: "{{upstream}}", itemTemplate: "{{item}}", maxItems: 30, concurrency: 4 };
    if (type === "merge") base.config = { label: "Merge", budget: 50000, keep: 10, strategy: "summarize-rest" };
    if (type === "write") base.config = { label: "Write file", file: "briefs/output.md", text: "{{upstream}}" };
    if (type === "read") base.config = { label: "Read file", file: "briefs/seed.md" };
    if (type === "fetch") base.config = { label: "Fetch URL", template: "{{upstream}}", maxChars: 20000 };
    return base;
}

function starterGraph() {
    const a = defaultNode("input", 60, 140);
    const b = defaultNode("llm", 300, 140);
    b.config.label = "Answer";
    const c = defaultNode("output", 540, 140);
    return { nodes: [a, b, c], edges: [{ id: nid("e"), from: a.id, to: b.id }, { id: nid("e"), from: b.id, to: c.id }] };
}

/** Parallel research: one brief, three scout agents at once, a join, and a synthesis. */
function researchGraph() {
    const input = defaultNode("input", 40, 260);
    const brief = defaultNode("prompt", 250, 260);
    brief.config = { label: "Brief", text: "Research this and return focused findings:\n\n{{input}}" };
    const angles = [
        ["Scout — sources", 40, "Find primary sources, papers, and data on the brief below. Return each claim with its citation.\n\n{{upstream}}"],
        ["Scout — practice", 260, "Find how this works in practice: code, docs, and real examples for the brief below. Return paths, links, and short quotes.\n\n{{upstream}}"],
        ["Scout — critic", 480, "Argue against the brief below. Find failure cases, risks, and counter-evidence.\n\n{{upstream}}"],
    ];
    const scouts = angles.map(([label, y, prompt]) => {
        const n = defaultNode("agent", 480, y);
        n.config = { label, system: "", prompt, model: "", thinking: "session", onError: "continue" };
        return n;
    });
    const join = defaultNode("prompt", 730, 260);
    join.config = { label: "Join", text: "SOURCES:\n{{Scout — sources}}\n\nPRACTICE:\n{{Scout — practice}}\n\nCRITIC:\n{{Scout — critic}}" };
    const synth = defaultNode("llm", 960, 260);
    synth.config = { label: "Synthesize", system: "", model: "", prompt: "Merge the scout reports below into one answer. Keep the citations, and flag where the scouts disagree.\n\n{{upstream}}" };
    const out = defaultNode("output", 1200, 260);
    const nodes = [input, brief, ...scouts, join, synth, out];
    const edges = [
        { id: nid("e"), from: input.id, to: brief.id },
        ...scouts.map((s) => ({ id: nid("e"), from: brief.id, to: s.id })),
        ...scouts.map((s) => ({ id: nid("e"), from: s.id, to: join.id })),
        { id: nid("e"), from: join.id, to: synth.id },
        { id: nid("e"), from: synth.id, to: out.id },
    ];
    return { nodes, edges };
}

/** Goal in, verified checklist out: draft, refine loop, format check, human approval. */
function checklistGraph() {
    const input = defaultNode("input", 40, 260);
    const draft = defaultNode("llm", 250, 260);
    draft.config = { label: "Draft checklist", system: "You write short, actionable checklists.", prompt: "Turn this goal into a markdown checklist.\nRules:\n- 5-10 steps\n- Each step on its own line as \"- [ ] ...\"\n- Each step concrete and verifiable, in order\n- Add done-criteria in parentheses\n\nGoal:\n{{input}}", model: "" };
    const refine = defaultNode("loop", 480, 260);
    refine.config = { label: "Refine", system: "", prompt: "Improve this checklist. Make each step smaller, ordered, verifiable. Keep markdown checkboxes, 5-10 steps.\n\n{{prev}}", times: 2, until: "", model: "" };
    const validate = defaultNode("code", 700, 260);
    validate.config = { label: "Validate", code: "const lines = upstream.split('\\n');\nconst items = lines.filter(l => l.trim().startsWith('- [ ]'));\nif (items.length === 0) throw new Error(\"No checklist items found. Draft step must output '- [ ]' lines.\");\nreturn upstream.trim() + `\\n\\n<!-- items: ${items.length} -->`;", timeout: 10 };
    const approve = defaultNode("approval", 920, 260);
    approve.config = { label: "Approve checklist", title: "Approve this checklist?", text: "{{upstream}}", askInput: false, onDecline: "stop" };
    const out = defaultNode("output", 1140, 260);
    out.config = { label: "Output", text: "# Checklist\n\nGoal: {{input}}\n\n{{Approve checklist}}" };
    const nodes = [input, draft, refine, validate, approve, out];
    const edges = [
        { id: nid("e"), from: input.id, to: draft.id },
        { id: nid("e"), from: draft.id, to: refine.id },
        { id: nid("e"), from: refine.id, to: validate.id },
        { id: nid("e"), from: validate.id, to: approve.id },
        { id: nid("e"), from: approve.id, to: out.id },
    ];
    return { nodes, edges };
}

export default function setup(pocket) {
    const { html, useEffect, useRef, useState } = pocket;
    pocket.style("style.css");

    function PipelinesPage() {
        const [defs, setDefs] = useState(null);
        const [defId, setDefId] = useState("");
        const [name, setName] = useState("Untitled pipeline");
        const [graph, setGraph] = useState(starterGraph);
        const [selNode, setSelNode] = useState(null);
        const [selEdge, setSelEdge] = useState(null);
        const [pending, setPending] = useState(null); // node id we connect FROM
        const [view, setView] = useState({ x: 0, y: 0, k: 1 });
        const [runs, setRuns] = useState([]);
        const [openRun, setOpenRun] = useState(null);
        const [sessions, setSessions] = useState([]);
        const [sessionId, setSessionId] = useState(pocket.conversationId() || "");
        const [models, setModels] = useState([]);
        const [thinkingLevels, setThinkingLevels] = useState([]);
        const [apiKeys, setApiKeys] = useState({});
        const [input, setInput] = useState("");
        const [paramsText, setParamsText] = useState("{}");
        const [msg, setMsg] = useState("");
        const [err, setErr] = useState("");
        const [busy, setBusy] = useState(false);
        const worldRef = useRef(null);
        const dragRef = useRef(null);

        const loadDefs = async () => {
            const d = await pocket.api("defs");
            setDefs(d.items);
            return d.items;
        };
        const loadRuns = async () => {
            const r = await pocket.api("runs");
            setRuns(r.items);
        };
        useEffect(() => {
            loadDefs().catch((e) => setErr(e.message));
            loadRuns().catch(() => {});
            pocket.api("sessions").then((s) => {
                setSessions(s.items);
                setSessionId((cur) => cur || (s.items[0] && s.items[0].id) || "");
            }).catch(() => {});
            pocket.api("meta").then((m) => { setModels(m.models || []); setThinkingLevels(m.thinkingLevels || []); setApiKeys(m.keys || {}); }).catch(() => {});
            const offRun = pocket.on("run", (run) => {
                if (!run || !run.id) return;
                setRuns((prev) => [run, ...prev.filter((r) => r.id !== run.id)].slice(0, 50));
            });
            const offDefs = pocket.on("defs", () => loadDefs().catch(() => {}));
            return () => { offRun(); offDefs(); };
        }, []);

        const propsRef = useRef(null);
        useEffect(() => {
            if ((selNode || selEdge) && propsRef.current && typeof propsRef.current.scrollIntoView === "function") {
                propsRef.current.scrollIntoView({ block: "nearest", behavior: "smooth" });
            }
        }, [selNode, selEdge]);

        const node = graph.nodes.find((n) => n.id === selNode) || null;
        const edge = graph.edges.find((e) => e.id === selEdge) || null;

        const patchNode = (id, patch) => setGraph((g) => ({ ...g, nodes: g.nodes.map((n) => (n.id === id ? { ...n, ...patch } : n)) }));
        const patchConfig = (id, key, value) =>
            setGraph((g) => ({ ...g, nodes: g.nodes.map((n) => (n.id === id ? { ...n, config: { ...n.config, [key]: value } } : n)) }));

        const addNode = (type) => {
            // Each instance gets its own name ("Answer", "Answer 2", ...) so cards stay
            // distinguishable and {{Step name}} template refs are unambiguous. Rename any
            // time in the editor below; names only need to be unique when you refer to them.
            const taken = new Set(graph.nodes.map((x) => (x.config && x.config.label) || ""));
            const base = (TYPES.find((t) => t.type === type) || {}).label || type;
            let label = base;
            for (let i = 2; taken.has(label); i++) label = `${base} ${i}`;
            const n = defaultNode(type, 120 - view.x / view.k + graph.nodes.length * 18, 100 - view.y / view.k + graph.nodes.length * 14);
            n.config.label = label;
            setGraph((g) => {
                const names = new Set(g.nodes.map((x) => (x.config && x.config.label) || ""));
                let finalLabel = n.config.label;
                for (let i = 2; names.has(finalLabel); i++) finalLabel = `${base} ${i}`;
                return { ...g, nodes: [...g.nodes, { ...n, config: { ...n.config, label: finalLabel } }] };
            });
            setSelNode(n.id); setSelEdge(null);
        };
        const deleteSelected = () => {
            if (selNode) {
                setGraph((g) => ({ nodes: g.nodes.filter((n) => n.id !== selNode), edges: g.edges.filter((e) => e.from !== selNode && e.to !== selNode) }));
                setSelNode(null);
            } else if (selEdge) {
                setGraph((g) => ({ ...g, edges: g.edges.filter((e) => e.id !== selEdge) }));
                setSelEdge(null);
            }
        };

        const onPortOut = (e, id) => { e.stopPropagation(); setPending(id); setMsg("Now tap the ◂ input dot of the target node."); };
        const onPortIn = (e, id) => {
            e.stopPropagation();
            if (pending && pending !== id) {
                const edge = { id: nid("e"), from: pending, to: id };
                setGraph((g) => (g.edges.some((x) => x.from === edge.from && x.to === edge.to) ? g : { ...g, edges: [...g.edges, edge] }));
            }
            setPending(null); setMsg("");
        };

        const startDrag = (e, n) => {
            if (e.target.closest(".pport")) return;
            e.preventDefault();
            const start = { px: e.clientX, py: e.clientY, nx: n.x, ny: n.y, id: n.id, moved: false };
            dragRef.current = start;
            const move = (ev) => {
                const dx = (ev.clientX - start.px) / view.k, dy = (ev.clientY - start.py) / view.k;
                if (Math.abs(dx) + Math.abs(dy) > 2) start.moved = true;
                patchNode(start.id, { x: Math.round(start.nx + dx), y: Math.round(start.ny + dy) });
            };
            const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); dragRef.current = null; };
            window.addEventListener("pointermove", move);
            window.addEventListener("pointerup", up);
            setSelNode(n.id); setSelEdge(null);
        };
        const startPan = (e) => {
            if (e.target.closest(".pnode") || e.target.closest("button") || e.target.closest("input") || e.target.closest("textarea") || e.target.closest("select")) return;
            const start = { px: e.clientX, py: e.clientY, vx: view.x, vy: view.y };
            const move = (ev) => setView((v) => ({ ...v, x: start.vx + ev.clientX - start.px, y: start.vy + ev.clientY - start.py }));
            const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
            window.addEventListener("pointermove", move);
            window.addEventListener("pointerup", up);
        };

        const save = async () => {
            setBusy(true); setErr("");
            try {
                const saved = await pocket.api("defs", { id: defId || undefined, name, graph });
                setDefId(saved.id); await loadDefs(); setMsg(`Saved “${saved.name}”.`);
            } catch (e) { setErr(e.message); } finally { setBusy(false); }
        };
        const loadDef = (d) => { setDefId(d.id); setName(d.name); setGraph(JSON.parse(JSON.stringify(d.graph))); setSelNode(null); setSelEdge(null); setMsg(""); };
        const newPipe = () => { setDefId(""); setName("Untitled pipeline"); setGraph(starterGraph()); setSelNode(null); setSelEdge(null); };
        const applyResearch = () => { setDefId(""); setName("Research scouts"); setGraph(researchGraph()); setSelNode(null); setSelEdge(null); setMsg("Template loaded: 3 scout agents run in parallel. Save, then Run."); };
        const applyChecklist = () => { setDefId(""); setName("Checklist"); setGraph(checklistGraph()); setSelNode(null); setSelEdge(null); setMsg("Template loaded: goal in, verified checklist out with human approval. Save, then Run."); };
        const removeDef = async () => {
            if (!defId) return;
            setBusy(true);
            try { await pocket.api("defs/delete", { id: defId }); newPipe(); await loadDefs(); } catch (e) { setErr(e.message); } finally { setBusy(false); }
        };
        const run = async () => {
            setErr("");
            if (!defId) { setErr("Save the pipeline first, then Run."); return; }
            if (!sessionId) { setErr("Pick a session to run in (its model, folder and spend apply)."); return; }
            setBusy(true);
            let params;
            try { params = paramsText.trim() === "" ? {} : JSON.parse(paramsText); } catch (e) { setErr("Params are not valid JSON."); setBusy(false); return; }
            try {
                const r = await pocket.api(`runs/${sessionId}`, { pipelineId: defId, input, params });
                setRuns((prev) => [r, ...prev.filter((x) => x.id !== r.id)]);
                setOpenRun(r.id); setMsg("Run started — it checkpoints after each batch and survives a restart.");
            } catch (e) { setErr(e.message); } finally { setBusy(false); }
        };
        const stopRun = async (id) => { try { await pocket.api("runs/stop", { runId: id }); setMsg("Stop requested — it lands at the next node boundary."); } catch (e) { setErr(e.message); } };

        const W = 2400, H = 1600;
        const pos = (id) => graph.nodes.find((n) => n.id === id) || { x: 0, y: 0 };
        const pathFor = (e) => {
            const a = pos(e.from), b = pos(e.to);
            const x1 = a.x + 176, y1 = a.y + 30, x2 = b.x, y2 = b.y + 30;
            const dx = Math.max(40, Math.abs(x2 - x1) / 2);
            return `M${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
        };
        const runItem = runs.find((r) => r.id === openRun) || null;
        const statusTone = (s) => (s === "done" ? "var(--ok)" : s === "failed" ? "var(--err)" : s === "stopped" ? "var(--muted)" : "var(--warn)");

        return html`<div class="pipe-wrap">
            <div class="pipe-bar">
                <select class="pipe-in" value=${defId} onChange=${(e) => { const d = (defs || []).find((x) => x.id === e.target.value); if (d) loadDef(d); }}>
                    <option value="">— choose a pipeline —</option>
                    ${(defs || []).map((d) => html`<option value=${d.id}>${d.name}</option>`)}
                </select>
                <input class="pipe-in grow" value=${name} onInput=${(e) => setName(e.target.value)} placeholder="Pipeline name" />
                <button class="button" onClick=${newPipe}>New</button>
                <button class="button" onClick=${applyResearch}>Template: Research scouts</button>
                <button class="button" onClick=${applyChecklist}>Template: Checklist</button>
                <button class="button primary" disabled=${busy} onClick=${save}>Save</button>
                ${defId ? html`<button class="button" disabled=${busy} onClick=${removeDef}>Delete</button>` : null}
            </div>
            <div class="pipe-bar">
                ${TYPES.map((t) => html`<button class="button pipe-add" onClick=${() => addNode(t.type)}><span class="pdot" style=${`background:${t.color}`}></span>${t.label}</button>`)}
                <button class="button" disabled=${!selNode && !selEdge} onClick=${deleteSelected}>Delete selected</button>
                <button class="button" onClick=${() => setView((v) => ({ ...v, k: Math.min(1.6, v.k + 0.1) }))}>＋</button>
                <button class="button" onClick=${() => setView((v) => ({ ...v, k: Math.max(0.4, v.k - 0.1) }))}>－</button>
                <button class="button" onClick=${() => setView({ x: 0, y: 0, k: 1 })}>Reset view</button>
            </div>
            ${pending ? html`<p class="small" style="color:var(--accent)">Connecting — tap a target's left dot. <button class="button" onClick=${() => setPending(null)}>Cancel</button></p>` : null}
            ${err ? html`<div class="error-box">${err}</div>` : null}
            ${msg ? html`<p class="muted small">${msg}</p>` : null}

            <div class="pipe-canvas" onPointerDown=${startPan}>
                <div class="pipe-world" ref=${worldRef} style=${`transform:translate(${view.x}px,${view.y}px) scale(${view.k});width:${W}px;height:${H}px`}>
                    <svg class="pipe-edges" width=${W} height=${H}>
                        ${graph.edges.map((e) => html`<path d=${pathFor(e)} class=${"pedge" + (e.id === selEdge ? " sel" : "")} stroke=${e.when ? "var(--warn)" : "var(--muted)"} onClick=${(ev) => { ev.stopPropagation(); setSelEdge(e.id); setSelNode(null); }} />`)}
                    </svg>
                    ${graph.nodes.map((n) => {
                        const runOut = runItem && runItem.outputs[n.id];
                        const running = runItem && (runItem.current || []).includes(n.id);
                        return html`<div class=${"pnode" + (n.id === selNode ? " sel" : "")} style=${`left:${n.x}px;top:${n.y}px;border-color:${colorOf(n.type)}`} onPointerDown=${(e) => startDrag(e, n)} onClick=${() => { setSelNode(n.id); setSelEdge(null); }}>
                            <div class="pnode-head"><span class="pdot" style=${`background:${colorOf(n.type)}`}></span><b>${labelOf(n)}</b><span class="muted small">${n.type}</span>
                            ${running ? html`<span class="small" style="color:var(--warn)">running…</span>` : runOut !== undefined && runOut !== false ? html`<span class="small" style="color:var(--ok)">✓</span>` : null}</div>
                            <div class="pnode-sub muted small">${n.type === "llm" || n.type === "agent" ? n.config.model || "session model" : n.type === "bash" ? String(n.config.command || "").slice(0, 34) : n.type === "subpipe" ? String(n.config.pipeline || "").slice(0, 34) : n.type === "branch" ? `${n.config.mode || "contains"} “${n.config.value || ""}”` : n.type === "decision" ? `${n.config.provider || "jev"} · ${n.config.kind === "noul" ? "yes/no" : n.config.kind === "score" ? "score" : `${String(n.config.categories || "").split("\n").filter((l) => l.trim() !== "").length} choices`}` : n.type === "refine" ? `×${n.config.times || 3}` : n.type === "map" ? `${n.config.concurrency || 4}× ${String(n.config.pipeline || "").slice(0, 24)}` : n.type === "merge" ? `≤${n.config.budget || 50000}t` : n.type === "write" || n.type === "read" || n.type === "fetch" ? String(n.config.file || n.config.template || "").slice(0, 34) : ""}</div>
                            <span class="pport in" title="Input — tap after choosing an output" onPointerDown=${(e) => onPortIn(e, n.id)}></span>
                            <span class="pport out" title="Output — tap, then tap a target input" onPointerDown=${(e) => onPortOut(e, n.id)}></span>
                        </div>`;
                    })}
                </div>
            </div>
            <p class="muted small">Drag nodes to move · drag empty space to pan · tap a node's right dot, then another node's left dot, to connect (fan-out and fan-in both work). Tap an edge to set a branch condition or delete it.</p>

            ${node ? html`<div class="pipe-props" ref=${propsRef}>
                <div class="setting"><div class="grow"><b>✎ Edit step — ${labelOf(node)}</b> <span class="muted small">${node.type} · ${node.id}</span></div>
                <button class="button" onClick=${() => { patchNode(node.id, { x: node.x, y: node.y }); setGraph((g) => ({ nodes: g.nodes.filter((n) => n.id !== node.id), edges: g.edges.filter((e) => e.from !== node.id && e.to !== node.id) })); setSelNode(null); }}>Delete node</button></div>
                <label class="pipe-field">Step name — this card's title; other steps read its output as {{name}}<input class="pipe-in" value=${node.config.label || ""} onInput=${(e) => patchConfig(node.id, "label", e.target.value)} placeholder=${node.type} /></label>
                ${node.type === "llm" || node.type === "refine" || node.type === "agent" ? html`
                    <label class="pipe-field">Model (blank = run session's model)
                        <select class="pipe-in" value=${node.config.model || ""} onChange=${(e) => patchConfig(node.id, "model", e.target.value)}>
                            <option value="">Session model</option>
                            ${models.map((m) => html`<option value=${m}>${m}</option>`)}
                        </select></label>
                    <label class="pipe-field">${node.type === "agent" ? "Instructions for the sub-session" : "System"}<textarea class="pipe-in" rows="2" value=${node.config.system || ""} onInput=${(e) => patchConfig(node.id, "system", e.target.value)}></textarea></label>` : null}
                ${node.type === "agent" ? html`
                    <label class="pipe-field">Thinking<select class="pipe-in" value=${node.config.thinking || "session"} onChange=${(e) => patchConfig(node.id, "thinking", e.target.value)}>
                        <option value="session">Session level</option>
                        ${thinkingLevels.map((l) => html`<option value=${l}>${l}</option>`)}</select></label>
                    <p class="muted small">Starts a real Pi sub-session with its own tools and transcript (no pipeline tools). Its answer becomes this node's output. Open it from the run below while it works.</p>` : null}
                ${node.type === "llm" || node.type === "agent" ? html`<label class="pipe-field">Prompt<textarea class="pipe-in" rows="5" value=${node.config.prompt || ""} onInput=${(e) => patchConfig(node.id, "prompt", e.target.value)}></textarea></label>` : null}
                ${node.type === "refine" ? html`
                    <label class="pipe-field">Prompt ({{prev}} = last round)<textarea class="pipe-in" rows="5" value=${node.config.prompt || ""} onInput=${(e) => patchConfig(node.id, "prompt", e.target.value)}></textarea></label>
                    <label class="pipe-field">Rounds<input class="pipe-in" type="number" min="1" max="20" value=${node.config.times ?? 3} onInput=${(e) => patchConfig(node.id, "times", e.target.value === "" ? "" : Number(e.target.value))} /></label>
                    <label class="pipe-field">Stop early when output contains<input class="pipe-in" value=${node.config.until || ""} onInput=${(e) => patchConfig(node.id, "until", e.target.value)} /></label>` : null}
                ${node.type === "map" ? html`
                    <label class="pipe-field">Pipeline (runs once per item)<select class="pipe-in" value=${node.config.pipeline || ""} onChange=${(e) => patchConfig(node.id, "pipeline", e.target.value)}>
                        <option value="">— choose —</option>
                        ${(defs || []).map((d) => html`<option value=${d.id}>${d.name}</option>`)}</select></label>
                    <label class="pipe-field">List — JSON array, one item per line, file:path, or folder:path (of .txt files)<textarea class="pipe-in mono" rows="4" value=${node.config.list || ""} onInput=${(e) => patchConfig(node.id, "list", e.target.value)}></textarea></label>
                    <label class="pipe-field">Child input template<textarea class="pipe-in" rows="2" value=${node.config.itemTemplate || "{{item}}"} onInput=${(e) => patchConfig(node.id, "itemTemplate", e.target.value)}></textarea></label>
                    <label class="pipe-field">Max items<input class="pipe-in" type="number" min="1" max="100" value=${node.config.maxItems ?? 30} onInput=${(e) => patchConfig(node.id, "maxItems", e.target.value === "" ? "" : Number(e.target.value))} /></label>
                    <label class="pipe-field">At once (1 = sequential, saves quota)<input class="pipe-in" type="number" min="1" max="8" value=${node.config.concurrency ?? 4} onInput=${(e) => patchConfig(node.id, "concurrency", e.target.value === "" ? "" : Number(e.target.value))} /></label>
                    <p class="muted small">Outputs a JSON array of {item, output}. Each child is its own durable run — {{item}} and {{index}} are available in its input.</p>` : null}
                ${node.type === "merge" ? html`
                    <label class="pipe-field">Budget (tokens)<input class="pipe-in" type="number" min="100" max="500000" step="1000" value=${node.config.budget ?? 50000} onInput=${(e) => patchConfig(node.id, "budget", e.target.value === "" ? "" : Number(e.target.value))} /></label>
                    <label class="pipe-field">Keep whole (top N)<input class="pipe-in" type="number" min="1" max="100" value=${node.config.keep ?? 10} onInput=${(e) => patchConfig(node.id, "keep", e.target.value === "" ? "" : Number(e.target.value))} /></label>
                    <label class="pipe-field">The rest<select class="pipe-in" value=${node.config.strategy || "summarize-rest"} onChange=${(e) => patchConfig(node.id, "strategy", e.target.value)}><option value="summarize-rest">Summarize into one brief</option><option value="drop-rest">Drop</option></select></label>
                    <p class="muted small">Items with a numeric score rank first. The rest are summarized with the run's model.</p>` : null}
                ${node.type === "write" ? html`
                    <label class="pipe-field">Path (in the run folder)<input class="pipe-in mono" value=${node.config.file || ""} onInput=${(e) => patchConfig(node.id, "file", e.target.value)} placeholder="briefs/report.md" /></label>
                    <label class="pipe-field">Text<textarea class="pipe-in" rows="5" value=${node.config.text || ""} onInput=${(e) => patchConfig(node.id, "text", e.target.value)}></textarea></label>
                    <p class="muted small">Tracked in the run's files. Downstream steps read the path from {{Label}}.</p>` : null}
                ${node.type === "read" ? html`
                    <label class="pipe-field">Path (in the run folder)<input class="pipe-in mono" value=${node.config.file || ""} onInput=${(e) => patchConfig(node.id, "file", e.target.value)} placeholder="briefs/seed.md" /></label>
                    <p class="muted small">Outputs the file's text (first 100k chars). A later run can seed from the same path.</p>` : null}
                ${node.type === "fetch" ? html`
                    <label class="pipe-field">URL<textarea class="pipe-in" rows="2" value=${node.config.template || ""} onInput=${(e) => patchConfig(node.id, "template", e.target.value)} placeholder="https://… or {{upstream}}"></textarea></label>
                    <label class="pipe-field">Max chars<input class="pipe-in" type="number" min="100" max="100000" step="1000" value=${node.config.maxChars ?? 20000} onInput=${(e) => patchConfig(node.id, "maxChars", e.target.value === "" ? "" : Number(e.target.value))} /></label>
                    <p class="muted small">No key needed. Thin pages (&lt;500 chars) are flagged — they may need JS rendering.</p>` : null}
                ${node.type === "prompt" || node.type === "output" ? html`<label class="pipe-field">Text<textarea class="pipe-in" rows="5" value=${node.config.text || ""} onInput=${(e) => patchConfig(node.id, "text", e.target.value)}></textarea></label>` : null}
                ${node.type === "bash" ? html`
                    <label class="pipe-field">Command (runs in the run session's folder)<textarea class="pipe-in" rows="4" value=${node.config.command || ""} onInput=${(e) => patchConfig(node.id, "command", e.target.value)}></textarea></label>
                    <label class="pipe-field">Timeout (seconds)<input class="pipe-in" type="number" min="1" max="600" value=${node.config.timeout ?? 120} onInput=${(e) => patchConfig(node.id, "timeout", e.target.value === "" ? "" : Number(e.target.value))} /></label>` : null}
                ${node.type === "branch" ? html`
                    <label class="pipe-field">Test this text<textarea class="pipe-in" rows="3" value=${node.config.template || ""} onInput=${(e) => patchConfig(node.id, "template", e.target.value)}></textarea></label>
                    <label class="pipe-field">Mode<select class="pipe-in" value=${node.config.mode || "contains"} onChange=${(e) => patchConfig(node.id, "mode", e.target.value)}>
                        <option value="contains">contains</option><option value="equals">equals</option><option value="truthy">is non-empty</option></select></label>
                    <label class="pipe-field">Value<input class="pipe-in" value=${node.config.value || ""} onInput=${(e) => patchConfig(node.id, "value", e.target.value)} /></label>
                    <p class="muted small">Then tap each edge leaving this node and set it to “when true” or “when false”.</p>` : null}
                ${node.type === "decision" ? html`
                    <label class="pipe-field">Classifier<select class="pipe-in" value=${node.config.provider || "jev"} onChange=${(e) => patchConfig(node.id, "provider", e.target.value)}>
                        <option value="jev">Jev — direct (typesafe.ai)</option><option value="openrouter">Jev — via OpenRouter</option><option value="openai">OpenAI Decisions</option></select></label>
                    ${!(apiKeys[node.config.provider || "jev"]) ? html`<p class="small" style="color:var(--warn)">No key found for this provider — add one to the Secrets catalog (Menu → Secrets), Pipelines settings, or set ${node.config.provider === "openai" ? "OPENAI_API_KEY" : node.config.provider === "openrouter" ? "OPENROUTER_API_KEY" : "TYPESAFE_API_KEY"} on the server.</p>` : null}
                    <label class="pipe-field">Judge<select class="pipe-in" value=${node.config.kind || "choice"} onChange=${(e) => patchConfig(node.id, "kind", e.target.value)}>
                        <option value="choice">Choice — pick one category</option><option value="noul">Yes / No — answer a yes-no question</option><option value="score">Score — rate against ordered levels</option></select></label>
                    <label class="pipe-field">Text to judge<textarea class="pipe-in" rows="3" value=${node.config.template || ""} onInput=${(e) => patchConfig(node.id, "template", e.target.value)}></textarea></label>
                    <label class="pipe-field">Question<textarea class="pipe-in" rows="2" value=${node.config.instructions || ""} onInput=${(e) => patchConfig(node.id, "instructions", e.target.value)} placeholder="Which team should handle this?"></textarea></label>
                    ${node.config.kind === "noul" ? html`
                        <label class="pipe-field">Yes when P(yes) ≥ (%)<input class="pipe-in" type="number" min="0" max="100" value=${node.config.threshold ?? 50} onInput=${(e) => patchConfig(node.id, "threshold", e.target.value === "" ? "" : Number(e.target.value))} /></label>
                        <p class="muted small">Outputs “true” or “false”. Route edges with “when true” / “when false”.</p>` : node.config.kind === "score" ? html`
                        <label class="pipe-field">Levels — one “label: when it applies” per line, lowest first<textarea class="pipe-in mono" rows="4" value=${node.config.categories || ""} onInput=${(e) => patchConfig(node.id, "categories", e.target.value)}></textarea></label>
                        <label class="pipe-field">High at score ≥<input class="pipe-in" type="number" min="0" max="9" step="0.5" value=${node.config.cut ?? ""} onInput=${(e) => patchConfig(node.id, "cut", e.target.value === "" ? "" : Number(e.target.value))} placeholder="middle of the levels" /></label>
                        <p class="muted small">Outputs “high” or “low”. Route edges with “when high” / “when low”.</p>` : html`
                        <label class="pipe-field">Categories — one “name: when it applies” per line<textarea class="pipe-in mono" rows="5" value=${node.config.categories || ""} onInput=${(e) => patchConfig(node.id, "categories", e.target.value)}></textarea></label>
                        <p class="muted small">Outputs the winning category name. Tap each edge leaving this step and set “when” to a category name.</p>`}
                    <label class="pipe-field">Model (blank = provider default: jev-latest · typesafe/jev-1.14 · gpt-6-luna)<input class="pipe-in" value=${node.config.model || ""} onInput=${(e) => patchConfig(node.id, "model", e.target.value)} placeholder="provider default" /></label>
                    <label class="pipe-field">Unsure below confidence (%)<input class="pipe-in" type="number" min="0" max="100" value=${node.config.minConfidence ?? 0} onInput=${(e) => patchConfig(node.id, "minConfidence", e.target.value === "" ? "" : Number(e.target.value))} /></label>
                    <p class="muted small">0 = always take the winner. Above 0, low-confidence answers output “unsure” — route them with “when unsure”.</p>` : null}
                ${node.type === "code" ? html`
                    <label class="pipe-field">JavaScript — globals: input, upstream, outputs (by node id). Return a value, or console.log it. No tools, files, or network.<textarea class="pipe-in mono" rows="8" value=${node.config.code || ""} onInput=${(e) => patchConfig(node.id, "code", e.target.value)}></textarea></label>
                    <label class="pipe-field">Timeout (seconds, max 60)<input class="pipe-in" type="number" min="1" max="60" value=${node.config.timeout ?? 10} onInput=${(e) => patchConfig(node.id, "timeout", e.target.value === "" ? "" : Number(e.target.value))} /></label>` : null}
                ${node.type === "approval" ? html`
                    <label class="pipe-field">Card title<input class="pipe-in" value=${node.config.title || ""} onInput=${(e) => patchConfig(node.id, "title", e.target.value)} /></label>
                    <label class="pipe-field">Card text<textarea class="pipe-in" rows="4" value=${node.config.text || ""} onInput=${(e) => patchConfig(node.id, "text", e.target.value)}></textarea></label>
                    <label class="pipe-field">Ask for a typed answer too<select class="pipe-in" value=${node.config.askInput ? "yes" : "no"} onChange=${(e) => patchConfig(node.id, "askInput", e.target.value === "yes")}><option value="no">No — just Approve / Decline</option><option value="yes">Yes — one text field</option></select></label>
                    ${node.config.askInput ? html`<label class="pipe-field">Field label<input class="pipe-in" value=${node.config.value || ""} onInput=${(e) => patchConfig(node.id, "value", e.target.value)} /></label>` : null}
                    <label class="pipe-field">When declined<select class="pipe-in" value=${node.config.onDecline || "stop"} onChange=${(e) => patchConfig(node.id, "onDecline", e.target.value)}><option value="stop">Fail the run</option><option value="branch">Output “declined” (route it with a Branch)</option></select></label>
                    <p class="muted small">The run pauses. The card appears in the run's session — open that session to answer.</p>` : null}
                ${node.type === "subpipe" ? html`
                    <label class="pipe-field">Pipeline<select class="pipe-in" value=${node.config.pipeline || ""} onChange=${(e) => patchConfig(node.id, "pipeline", e.target.value)}>
                        <option value="">— choose —</option>
                        ${(defs || []).map((d) => html`<option value=${d.id}>${d.name}</option>`)}</select></label>
                    <label class="pipe-field">Its input<textarea class="pipe-in" rows="3" value=${node.config.text || ""} onInput=${(e) => patchConfig(node.id, "text", e.target.value)}></textarea></label>
                    <p class="muted small">Runs that pipeline as a child run (nesting at most 3 deep) and outputs its Output nodes.</p>` : null}
                ${node.type === "input" ? html`<p class="muted small">Outputs the text you type in Run input below.</p>` : null}
                ${["llm", "agent", "bash", "code", "decision", "refine", "map", "merge", "fetch", "subpipe"].includes(node.type) ? html`<label class="pipe-field">On error<select class="pipe-in" value=${node.config.onError || "fail"} onChange=${(e) => patchConfig(node.id, "onError", e.target.value)}><option value="fail">Stop the run</option><option value="continue">Continue without this step (output empty, noted in the run)</option></select></label>` : null}
                ${node.type !== "input" && node.type !== "output" ? html`<label class="pipe-field">Re-run cap (loop-back visits before the run fails)<input class="pipe-in" type="number" min="1" max="10" value=${node.config.maxVisits ?? 3} onInput=${(e) => patchConfig(node.id, "maxVisits", e.target.value === "" ? "" : Number(e.target.value))} /></label>` : null}
                <p class="muted small">Templates: {{input}} · {{upstream}} · {{Node label}} · {{node-id}} · {{param:name}}${node.type === "refine" ? " · {{prev}} · {{index}}" : ""}${node.type === "map" ? " · child input: {{item}} · {{index}}" : ""}</p>
            </div>` : null}

            ${edge ? html`<div class="pipe-props" ref=${propsRef}>
                <div class="setting"><div class="grow"><b>Connection</b> <span class="muted small">${edge.from} → ${edge.to}</span></div>
                <button class="button" onClick=${deleteSelected}>Delete edge</button></div>
                <label class="pipe-field">When<select class="pipe-in" value=${edge.when === "true" || edge.when === "false" ? edge.when : (edge.when ? edge.when : "")} onChange=${(e) => setGraph((g) => ({ ...g, edges: g.edges.map((x) => x.id === edge.id ? { ...x, ...(e.target.value ? { when: e.target.value.slice(0, 80) } : { when: undefined }) } : x) }))}>
                    <option value="">always</option><option value="true">when true (branch / yes-no)</option><option value="false">when false (branch / yes-no)</option>${(edge.when && edge.when !== "true" && edge.when !== "false") ? html`<option value=${edge.when}>when: ${edge.when}</option>` : null}</select></label>
                <label class="pipe-field">Or a route value (category, high/low, “unsure”, or anything the step outputs)<input class="pipe-in" value=${(edge.when === "true" || edge.when === "false") ? "" : (edge.when || "")} onInput=${(e) => setGraph((g) => ({ ...g, edges: g.edges.map((x) => x.id === edge.id ? { ...x, ...(e.target.value.trim() ? { when: e.target.value.trim().slice(0, 80) } : { when: undefined }) } : x) }))} placeholder="billing — or unsure" /></label>
                <label class="pipe-field">Loop-back note (appended to the target when this edge re-runs it)<input class="pipe-in" value=${edge.note || ""} onInput=${(e) => setGraph((g) => ({ ...g, edges: g.edges.map((x) => x.id === edge.id ? { ...x, ...(e.target.value.trim() ? { note: e.target.value.trim().slice(0, 2000) } : { note: undefined }) } : x) }))} placeholder="The page was a 404 — find the correct URL" /></label>
            </div>` : null}

            <div class="pipe-props">
                <b>Run</b>
                <label class="pipe-field">Run in session (its model, folder, spend)
                    <select class="pipe-in" value=${sessionId} onChange=${(e) => setSessionId(e.target.value)}>
                        <option value="">— pick a session —</option>
                        ${sessions.map((s) => html`<option value=${s.id}>${s.title || `Session ${s.id}`}</option>`)}
                    </select></label>
                <label class="pipe-field">Run input<textarea class="pipe-in" rows="3" value=${input} onInput=${(e) => setInput(e.target.value)} placeholder="Text for the Input node"></textarea></label>
                <label class="pipe-field">Params (JSON, read as {{param:name}})<input class="pipe-in mono" value=${paramsText} onInput=${(e) => setParamsText(e.target.value)} placeholder='{"depth":"deep", "breadth":"5"}' /></label>
                <button class="button primary" disabled=${busy} onClick=${run}>Run pipeline</button>
                <button class="button" onClick=${loadRuns}>Refresh runs</button>
            </div>

            <div class="pipe-runs">
                <b>Runs</b>
                ${runs.length === 0 ? html`<p class="muted small">No runs yet.</p>` : runs.map((r) => html`
                    <div class="setting">
                        <div class="grow">
                            <button class="button" onClick=${() => setOpenRun(openRun === r.id ? null : r.id)}>${r.name}</button>
                            <span class="small" style=${`color:${statusTone(r.status)}`}>${r.status}</span>
                            <span class="muted small">${new Date(r.createdAt).toLocaleString()}</span>
                            ${r.error ? html`<div class="small" style="color:var(--err)">${r.error}</div>` : null}
                        </div>
                        ${r.status === "queued" || r.status === "running" ? html`<button class="button" onClick=${() => stopRun(r.id)}>Stop</button>` : null}
                    </div>
                    ${openRun === r.id ? html`<div class="pipe-run-detail">
                        ${r.agentSessions ? Object.entries(r.agentSessions).map(([nid2, cid]) => { const src = ((r.graph && r.graph.nodes) || []).find((x) => x.id === nid2); return html`<p class="small">Agent step ${src && src.config && src.config.label ? `"${src.config.label}" ` : ""}${nid2}: <button class="button" onClick=${() => typeof pocket.openConversation === "function" && pocket.openConversation(cid)}>Open sub-session ${cid}</button></p>`; }) : null}
                        ${r.parentRunId ? html`<p class="muted small">Sub-run of ${r.parentRunId}</p>` : null}
                        ${r.params && Object.keys(r.params).length ? html`<p class="muted small">Params: ${Object.entries(r.params).map(([k, v]) => `${k}=${v}`).join(" · ")}</p>` : null}
                        ${(r.files || []).length ? html`<div><b class="small">Files (${r.files.length})</b>${r.files.map((f) => html`<div class="small mono">${f.path} <span class="muted">${f.bytes} bytes · ${f.label}</span></div>`)}</div>` : null}
                        ${Object.entries(r.outputs || {}).map(([id, text]) => { const src = ((r.graph && r.graph.nodes) || []).find((x) => x.id === id); const title = (src && src.config && src.config.label) || id; return html`<div><b class="small">${title}</b><pre class="pipe-out">${String(text).slice(0, 4000)}</pre></div>`; })}
                        ${(r.skipped || []).length ? html`<p class="muted small">Skipped: ${r.skipped.join(", ")}</p>` : null}
                        ${r.failedNodes && Object.keys(r.failedNodes).length ? html`<p class="small" style="color:var(--warn)">Failed but continued: ${Object.entries(r.failedNodes).map(([id, e]) => `${id}: ${e}`).join("; ")}</p>` : null}
                        <pre class="pipe-out">${(r.log || []).map((l) => l.text).join("\n")}</pre>
                    </div>` : null}`)}
            </div>
        </div>`;
    }

    pocket.page({ id: "pipelines", title: "Pipelines", component: PipelinesPage, swipe: false });
    pocket.rail({ id: "pipelines", title: "Pipelines", iconPath: FLOW, page: "pipelines" });
    pocket.launcher({ id: "pipelines", label: "Pipelines", detail: "Visual LLM workflows", iconPath: FLOW, page: "pipelines", keywords: ["workflow", "graph", "pipeline", "flow"] });
}
