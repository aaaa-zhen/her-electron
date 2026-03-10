// Quick test for the new modular tool system
const Module = require("module");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function(request, parent) {
  if (request === "electron") return request;
  return origResolve.apply(this, arguments);
};
require.cache[require.resolve("electron")] = {
  id: "electron", exports: { BrowserWindow: class {} }, loaded: true,
};

const { createTools } = require("./src/core/tools/index");

const result = createTools({
  paths: { sharedDir: "/tmp/her-test", dataDir: "/tmp/her-test-data" },
  stores: {
    memoryStore: { saveEntry() {}, deleteEntry() {}, list: () => [], search: () => [] },
    todoStore: { add: () => ({ id: "1", title: "t" }), complete: () => ({ title: "t" }), remove: () => ({ title: "t" }), list: () => [], listAll: () => [] },
    settingsStore: { get: () => ({}) },
  },
  scheduleService: { schedule: () => ({ message: "ok" }) },
  createAnthropicClient: () => ({}),
  emit: (e) => {},
});

async function run() {
  console.log("=== Tools Loaded ===");
  console.log("Count:", result.tools.length);
  result.tools.forEach(t => console.log("  " + t.name));

  console.log("\n=== Validation Tests ===");
  const tests = [
    { label: "bash(empty)", name: "bash", input: {}, expectError: true },
    { label: "bash(bad type)", name: "bash", input: { command: 123 }, expectError: true },
    { label: "unknown tool", name: "xxx", input: {}, expectError: true },
    { label: "memory(list)", name: "memory", input: { action: "list" }, expectError: false },
    { label: "todo(list)", name: "todo", input: { action: "list" }, expectError: false },
    { label: "todo(no action)", name: "todo", input: {}, expectError: true },
    { label: "bash(echo)", name: "bash", input: { command: "echo hello_from_tools" }, expectError: false },
    { label: "read_file(missing)", name: "read_file", input: {}, expectError: true },
    { label: "edit_file(bad)", name: "edit_file", input: { path: "/tmp/x" }, expectError: true },
    { label: "schedule_task", name: "schedule_task", input: { description: "test" }, expectError: false },
  ];

  let pass = 0, fail = 0;
  for (const t of tests) {
    const r = await result.execute({ id: "t", name: t.name, input: t.input }, []);
    const gotError = Boolean(r.is_error);
    const ok = gotError === t.expectError;
    console.log(`  ${ok ? "PASS" : "FAIL"} ${t.label}: is_error=${gotError} content="${(r.content || "").slice(0, 80)}"`);
    if (ok) pass++; else fail++;
  }

  console.log(`\n=== Result: ${pass} passed, ${fail} failed ===`);

  // Compare with old registry
  const { createTools: createToolsOld } = require("./src/core/tools/registry");
  const old = createToolsOld({
    paths: { sharedDir: "/tmp/her-test", dataDir: "/tmp/her-test-data" },
    stores: {
      memoryStore: { saveEntry() {}, deleteEntry() {}, list: () => [], search: () => [] },
      todoStore: { add: () => ({ id: "1", title: "t" }), complete: () => ({ title: "t" }), remove: () => ({ title: "t" }), list: () => [], listAll: () => [] },
    },
    scheduleService: { schedule: () => ({ message: "ok" }) },
    createAnthropicClient: () => ({}),
    emit: (e) => {},
  });

  console.log("\n=== Tool Name Comparison ===");
  const oldNames = old.tools.map(t => t.name).sort();
  const newNames = result.tools.map(t => t.name).sort();
  const missing = oldNames.filter(n => !newNames.includes(n));
  const extra = newNames.filter(n => !oldNames.includes(n));
  console.log("Old tools:", oldNames.length, "| New tools:", newNames.length);
  if (missing.length) console.log("MISSING from new:", missing);
  if (extra.length) console.log("EXTRA in new:", extra);
  if (!missing.length && !extra.length) console.log("MATCH: all tool names identical");
}

run().catch(e => { console.error("FATAL:", e); process.exit(1); });
