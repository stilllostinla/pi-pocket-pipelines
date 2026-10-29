// UI regression tests for the visual editor: rename a step, edit its text, save the payload, apply the template.
//
// Run:  cd tests && npm install && node ui.test.mjs
// Uses Pi Pocket's own Preact 11 (PI_POCKET_CODE, default /opt/pi-pocket): the event-name handling this guards
// differs between Preact versions, so testing against any other build proves nothing.
import { JSDOM } from "jsdom";

const POCKET = process.env.PI_POCKET_CODE || "/opt/pi-pocket";
const dom = new JSDOM("<!doctype html><body><div id=app></div></body>", { url: "http://x/", pretendToBeVisual: true });
global.window = dom.window; global.document = dom.window.document;
global.Node = dom.window.Node; global.Element = dom.window.Element; global.HTMLElement = dom.window.HTMLElement;
global.HTMLInputElement = dom.window.HTMLInputElement; global.HTMLTextAreaElement = dom.window.HTMLTextAreaElement;
global.PointerEvent = dom.window.PointerEvent || dom.window.MouseEvent; global.MouseEvent = dom.window.MouseEvent;
global.Event = dom.window.Event; global.requestAnimationFrame = (f) => setTimeout(f, 0);

const preact = await import(`${POCKET}/node_modules/preact/dist/preact.mjs`);
const hooks = await import(`${POCKET}/node_modules/preact/hooks/dist/hooks.mjs`);
const { act } = await import(`${POCKET}/node_modules/preact/test-utils/dist/testUtils.mjs`);
const htm = (await import(`${POCKET}/node_modules/htm/dist/htm.mjs`)).default;
const html = htm.bind(preact.h);

let Page; let savedBody = null;
const defGraph = { nodes: [
  { id: "a", type: "input", x: 60, y: 140, config: { label: "Input" } },
  { id: "b", type: "llm", x: 300, y: 140, config: { label: "LoadedAnswer", prompt: "old prompt", system: "", model: "" } },
], edges: [{ id: "e1", from: "a", to: "b" }] };
const pocket = { html, h: preact.h, Fragment: preact.Fragment, ...hooks,
  style: () => {}, conversationId: () => 1,
  Loader: ({ label }) => html`<div>${label}</div>`,
  page: (s) => { Page = s.component; }, rail: () => ({ update: () => {}, remove: () => {} }), launcher: () => ({ update: () => {}, remove: () => {} }),
  on: () => () => {},
  openConversation: () => {},
  api: async (path, body) => {
    if (path === "defs") { if (body) { savedBody = body; return { id: "d1", name: body.name, graph: body.graph }; } return { items: [{ id: "d1", name: "LoadedPipe", updatedAt: 1, graph: defGraph }] }; }
    if (path === "runs") return { items: [] };
    if (path === "sessions") return { items: [{ id: 1, title: "S1" }] };
    if (path === "meta") return { models: [], thinkingLevels: ["off", "high"] };
    return {};
  } };
const mod = await import("../pipelines/index.js");
await mod.default(pocket);
const flush = async (ms = 80) => act(async () => { await new Promise(r => setTimeout(r, ms)); });
await act(async () => { preact.render(html`<${Page} pocket=${pocket} close=${() => {}} />`, document.getElementById("app")); });
await flush();
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const fails = [];
const check = (name, cond) => { console.log((cond ? "PASS " : "FAIL ") + name); if (!cond) fails.push(name); };
const typeText = async (el, value, proto) => {
  if (!el) return;
  const setter = Object.getOwnPropertyDescriptor(proto.prototype, "value").set;
  // Type character by character, as a keyboard does: catches controlled inputs that eat or reset keystrokes.
  await act(async () => {
    el.focus();
    let v = "";
    for (const ch of value) { v += ch; setter.call(el, v); el.dispatchEvent(new dom.window.Event("input", { bubbles: true })); }
    await new Promise(r => setTimeout(r, 20));
  });
  check("focus stays in the field while typing", document.activeElement === el);
};
const click = async (el) => act(async () => { el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); await new Promise(r => setTimeout(r, 20)); });
const field = (label) => [...$$(".pipe-props")[0].querySelectorAll(".pipe-field")].find(f => f.textContent.startsWith(label));
const selectOption = async (el, value) => {
  if (!el) return;
  await act(async () => { el.value = value; el.dispatchEvent(new dom.window.Event("change", { bubbles: true })); await new Promise(r => setTimeout(r, 20)); });
};

// A: starter graph — rename + prompt
let firstNode = $$(".pnode").find(n => n.textContent.includes("Answer"));
await act(async () => { firstNode.dispatchEvent(new dom.window.MouseEvent("pointerdown", { bubbles: true })); await new Promise(r => setTimeout(r, 30)); });
check("starter node props open with an Edit step heading", ($$(".pipe-props")[0]?.textContent || "").includes("Edit step"));
await typeText(field("Step name")?.querySelector("input"), "Renamed", dom.window.HTMLInputElement);
check("starter step renames", $$(".pnode").some(n => n.textContent.includes("Renamed")));
await typeText(field("Prompt")?.querySelector("textarea"), "prompt {{input}}", dom.window.HTMLTextAreaElement);
check("starter prompt edits", field("Prompt")?.querySelector("textarea")?.value === "prompt {{input}}");
check("llm node offers on-error choice", !!field("On error"));

// B: loaded pipeline — rename + prompt persist into the save payload
const sel = $(".pipe-bar select");
await act(async () => { sel.value = "d1"; sel.dispatchEvent(new dom.window.Event("change", { bubbles: true })); await new Promise(r => setTimeout(r, 20)); });
const loaded = $$(".pnode").find(n => n.textContent.includes("LoadedAnswer"));
check("loaded pipeline renders its nodes", !!loaded);
await act(async () => { loaded.dispatchEvent(new dom.window.MouseEvent("pointerdown", { bubbles: true })); await new Promise(r => setTimeout(r, 30)); });
await typeText(field("Step name")?.querySelector("input"), "LoadedRenamed", dom.window.HTMLInputElement);
await typeText(field("Prompt")?.querySelector("textarea"), "new prompt {{input}}", dom.window.HTMLTextAreaElement);
check("loaded step renames", $$(".pnode").some(n => n.textContent.includes("LoadedRenamed")));

// C: new node from palette
await click($$(".pipe-add").find(b => b.textContent.includes("Prompt")));
await flush(30);
await typeText(field("Step name")?.querySelector("input"), "MyPromptStep", dom.window.HTMLInputElement);
await typeText(field("Text")?.querySelector("textarea"), "Summarize: {{upstream}}", dom.window.HTMLTextAreaElement);
check("new step renames + takes text", $$(".pnode").some(n => n.textContent.includes("MyPromptStep")));

// D: save payload carries every edit
await click($$("button").find(b => b.textContent === "Save"));
await flush(30);
const savedNodes = savedBody?.graph?.nodes ?? [];
check("save payload: loaded step", savedNodes.some(n => n.config.label === "LoadedRenamed" && n.config.prompt === "new prompt {{input}}"));
check("save payload: new step", savedNodes.some(n => n.config.label === "MyPromptStep" && n.config.text === "Summarize: {{upstream}}"));

// E: research template shape
await click($$("button").find(b => b.textContent.includes("Research scouts")));
await flush(30);
const tNodes = $$(".pnode");
check("template makes 8 nodes", tNodes.length === 8);
check("template has 3 scout agents", ["Scout — sources", "Scout — practice", "Scout — critic"].every(l => tNodes.some(n => n.textContent.includes(l))));
await click($$("button").find(b => b.textContent === "Save"));
await flush(30);
const tSaved = savedBody?.graph;
check("template graph: 9 edges", (tSaved?.edges ?? []).length === 9);
check("template scouts continue on error", (tSaved?.nodes ?? []).filter(n => n.type === "agent").every(n => n.config.onError === "continue"));
check("template join references scout labels", (tSaved?.nodes ?? []).some(n => (n.config.text || "").includes("{{Scout — critic}}")));

// F: decision step — configure choice classifier, connect it, route by category
await click($$("button").find(b => b.textContent === "New"));
await flush(30);
await click($$(".pipe-add").find(b => b.textContent.includes("Decision")));
await flush(30);
check("decision props open with Judge kind", !!field("Judge"));
await selectOption(field("Judge")?.querySelector("select"), "choice");
await typeText(field("Question")?.querySelector("textarea"), "Which team?", dom.window.HTMLTextAreaElement);
await typeText(field("Categories")?.querySelector("textarea"), "billing: money\ntechnical: broken", dom.window.HTMLTextAreaElement);
check("decision sub-line counts choices", $$(".pnode").some(n => n.textContent.includes("2 choices")));
await selectOption(field("Judge")?.querySelector("select"), "noul");
check("noul shows threshold", !!field("Yes when"));
check("noul sub-line says yes/no", $$(".pnode").some(n => n.textContent.includes("yes/no")));
await selectOption(field("Judge")?.querySelector("select"), "choice");
await typeText(field("Question")?.querySelector("textarea"), "Which team?", dom.window.HTMLTextAreaElement);
await typeText(field("Categories")?.querySelector("textarea"), "billing: money\ntechnical: broken", dom.window.HTMLTextAreaElement);
await click($$(".pipe-add").find(b => b.textContent.includes("Output")));
await flush(30);
const dNode = $$(".pnode").find(n => n.textContent.includes("Decision"));
const oNode = $$(".pnode").pop();
await act(async () => {
  dNode.querySelector(".pport.out").dispatchEvent(new dom.window.MouseEvent("pointerdown", { bubbles: true }));
  await new Promise(r => setTimeout(r, 20));
});
await act(async () => {
  oNode.querySelector(".pport.in").dispatchEvent(new dom.window.MouseEvent("pointerdown", { bubbles: true }));
  await new Promise(r => setTimeout(r, 30));
});
check("connecting decision to output adds an edge", $$(".pedge").length === 3);
await click($$(".pedge").pop());
await flush(30);
const edgePanel = $$(".pipe-props").find(x => x.textContent.includes("Connection"));
const whenInput = edgePanel
  ? [...edgePanel.querySelectorAll(".pipe-field")].find(f => f.textContent.startsWith("Or a route value"))?.querySelector("input")
  : null;
check("edge offers a category-name when", !!whenInput);
await typeText(whenInput, "billing", dom.window.HTMLInputElement);
await click($$("button").find(b => b.textContent === "Save"));
await flush(30);
const dSaved = savedBody?.graph;
check("save payload: decision config", (dSaved?.nodes ?? []).some(n => n.type === "decision" && n.config.kind === "choice" && (n.config.categories || "").includes("billing: money") && (n.config.instructions || "").includes("Which team?")));
check("save payload: edge when=billing", (dSaved?.edges ?? []).some(e => e.when === "billing"));

// G: decision provider + score kind persist into the save payload
const dNode2 = $$(".pnode").find(n => n.textContent.includes("Decision"));
await act(async () => { dNode2.dispatchEvent(new dom.window.MouseEvent("pointerdown", { bubbles: true })); await new Promise(r => setTimeout(r, 30)); });
await selectOption(field("Classifier")?.querySelector("select"), "openai");
await selectOption(field("Judge")?.querySelector("select"), "score");
check("provider switch warns without a key", ($$(".pipe-props")[0]?.textContent || "").includes("No key found"));
await typeText(field("Question")?.querySelector("textarea"), "How severe?", dom.window.HTMLTextAreaElement);
await typeText(field("Levels")?.querySelector("textarea"), "low: minor\nmid: workaround\nhigh: blocked", dom.window.HTMLTextAreaElement);
const cutInput = field("High at score")?.querySelector("input");
check("score shows cut field", !!cutInput);
await typeText(cutInput, "1.5", dom.window.HTMLInputElement);
await click($$("button").find(b => b.textContent === "Save"));
await flush(30);
const gSaved = savedBody?.graph;
check("save payload: decision provider+score", (gSaved?.nodes ?? []).some(n => n.type === "decision" && n.config.provider === "openai" && n.config.kind === "score" && (n.config.categories || "").includes("high: blocked") && n.config.cut === 1.5));

// H: v2 nodes — map, merge, write, read, fetch, refine
await click($$("button").find(b => b.textContent === "New"));
await flush(30);
for (const label of ["Map", "Merge", "Write file", "Read file", "Fetch URL", "Refine"]) {
  await click($$(".pipe-add").find(b => b.textContent.includes(label)));
  await flush(20);
}
check("v2 palette adds six nodes", $$(".pnode").length === 3 + 6);
check("no Loop node anymore", !$$(".pnode").some(n => n.textContent.includes("Loop")));
const mapNode = $$(".pnode").find(n => n.textContent.includes("Map"));
await act(async () => { mapNode.dispatchEvent(new dom.window.MouseEvent("pointerdown", { bubbles: true })); await new Promise(r => setTimeout(r, 30)); });
check("map props open", !!field("Pipeline (runs once per item)"));
await typeText(field("List")?.querySelector("textarea"), '["a", "b"]', dom.window.HTMLTextAreaElement);
await typeText(field("Child input template")?.querySelector("textarea"), "item={{item}}", dom.window.HTMLTextAreaElement);
const fetchNode = $$(".pnode").find(n => n.textContent.includes("Fetch URL"));
await act(async () => { fetchNode.dispatchEvent(new dom.window.MouseEvent("pointerdown", { bubbles: true })); await new Promise(r => setTimeout(r, 30)); });
await typeText(field("URL")?.querySelector("textarea"), "https://example.com/page", dom.window.HTMLTextAreaElement);
const mergeNode = $$(".pnode").find(n => n.textContent.includes("Merge"));
await act(async () => { mergeNode.dispatchEvent(new dom.window.MouseEvent("pointerdown", { bubbles: true })); await new Promise(r => setTimeout(r, 30)); });
await selectOption(field("The rest")?.querySelector("select"), "drop-rest");
// Edge note for loop-back
const firstEdge = $$(".pedge")[0];
await click(firstEdge);
await flush(30);
const noteInput = [...document.querySelectorAll(".pipe-props")].find(x => x.textContent.includes("Connection"))?.querySelectorAll(".pipe-field");
const noteField = [...(noteInput ?? [])].find(f => f.textContent.startsWith("Loop-back note"))?.querySelector("input");
check("edge offers loop-back note", !!noteField);
await typeText(noteField, "try again", dom.window.HTMLInputElement);
await click($$("button").find(b => b.textContent === "Save"));
await flush(30);
const hSaved = savedBody?.graph;
check("save payload: map config", (hSaved?.nodes ?? []).some(n => n.type === "map" && (n.config.list || "").includes('["a", "b"]') && (n.config.itemTemplate || "").includes("item={{item}}")));
check("save payload: merge strategy", (hSaved?.nodes ?? []).some(n => n.type === "merge" && n.config.strategy === "drop-rest"));
check("save payload: fetch url", (hSaved?.nodes ?? []).some(n => n.type === "fetch" && (n.config.template || "").includes("https://example.com/page")));
check("save payload: write/read/refine present", ["write", "read", "refine"].every(t => (hSaved?.nodes ?? []).some(n => n.type === t)));
check("save payload: edge note", (hSaved?.edges ?? []).some(e => e.note === "try again"));
check("run params field exists", [...document.querySelectorAll(".pipe-props")].some(x => x.textContent.includes("Params (JSON")));

console.log(fails.length ? `UI-FAIL (${fails.length})` : "UI-OK");
process.exit(fails.length ? 1 : 0);
