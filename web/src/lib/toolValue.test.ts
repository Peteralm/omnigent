import { describe, expect, it } from "vitest";
import {
  humanizeKey,
  isProseText,
  isoTimestampMs,
  parseToolOutput,
  pickTitleField,
  statusLabel,
  statusTone,
  toolErrorMessage,
} from "./toolValue";

describe("humanizeKey", () => {
  it.each([
    ["todoList", "Todo list"],
    ["next_run_at", "Next run at"],
    ["includeComments", "Include comments"],
    ["HTTPStatus", "HTTP status"],
    ["pr_ids", "PR IDs"],
    ["dry-run", "Dry run"],
  ])("%s -> %s", (key, label) => {
    expect(humanizeKey(key)).toBe(label);
  });

  it("keeps a key that has no word characters", () => {
    expect(humanizeKey("__")).toBe("__");
  });

  it("treats inherited object names as plain words", () => {
    // WHY: payload keys are arbitrary JSON; `constructor` must not hit Object.prototype.
    expect(humanizeKey("constructor")).toBe("Constructor");
    expect(humanizeKey("toString")).toBe("To string");
  });
});

describe("parseToolOutput", () => {
  it("reads JSON objects and arrays as JSON, anything else as text", () => {
    expect(parseToolOutput('{"a": 1}')).toEqual({
      kind: "json",
      value: { a: 1 },
      text: '{"a": 1}',
    });
    expect(parseToolOutput("[1, 2]")).toMatchObject({ kind: "json", value: [1, 2] });
    expect(parseToolOutput("42")).toEqual({ kind: "text", text: "42" });
    expect(parseToolOutput("{not json")).toEqual({ kind: "text", text: "{not json" });
  });

  it("unwraps an MCP content-block result to the JSON its text carries", () => {
    // WHY: Claude-native stores MCP results as content blocks, so the server's
    // JSON arrives as an escaped string inside `text`.
    const output = JSON.stringify([{ type: "text", text: '{"id": "OMNI-1", "state": "Done"}' }]);
    expect(parseToolOutput(output)).toEqual({
      kind: "json",
      value: { id: "OMNI-1", state: "Done" },
      text: '{"id": "OMNI-1", "state": "Done"}',
    });
  });

  it("unwraps text content blocks that are not JSON to plain text", () => {
    const output = JSON.stringify([
      { type: "text", text: "First part." },
      { type: "image", data: "..." },
      { type: "text", text: "Second part." },
    ]);
    expect(parseToolOutput(output)).toEqual({ kind: "text", text: "First part.\n\nSecond part." });
  });

  it("unwraps Omnigent's result wrapper around a harness's non-JSON output", () => {
    // WHY: a dispatched claude-sdk MCP failure is stored as `{"result": "Error: ..."}`.
    expect(parseToolOutput('{"result": "Error: 422 Validation Failed"}')).toEqual({
      kind: "text",
      text: "Error: 422 Validation Failed",
    });
    expect(parseToolOutput(JSON.stringify({ result: '{"id": "OMNI-1"}' }))).toMatchObject({
      kind: "json",
      value: { id: "OMNI-1" },
    });
    // A policy verdict carries more than the result, so it stays a record.
    expect(parseToolOutput('{"result": "DENY", "reason": "Blocked."}')).toMatchObject({
      kind: "json",
    });
  });

  it("keeps an array without text blocks as JSON", () => {
    const output = JSON.stringify([{ type: "tool_reference", tool_name: "sys_os_read" }]);
    expect(parseToolOutput(output)).toMatchObject({ kind: "json" });
  });
});

describe("toolErrorMessage", () => {
  it.each([
    ['{"error": "malformed arguments JSON"}', "malformed arguments JSON"],
    ['{"error": {"code": 404, "message": "Not found"}}', "Not found"],
    ["Error: 422 Validation Failed", "Error: 422 Validation Failed"],
    ["MCP error -32602: Invalid arguments", "MCP error -32602: Invalid arguments"],
    ["<tool_use_error>File does not exist.</tool_use_error>", "File does not exist."],
    ['{"error": true, "message": "Rate limited"}', "Rate limited"],
    ['{"error": true}', "The tool reported an error."],
    ['{"error": {"code": 500}}', "The tool reported an error."],
    ["<tool_use_error></tool_use_error>", "The tool reported an error."],
  ])("reports %s as a failure", (output, message) => {
    expect(toolErrorMessage(parseToolOutput(output))).toBe(message);
  });

  it.each([
    "Error handling in the parser works as expected.",
    '{"errors": []}',
    '{"error": null}',
    "Task plan updated (2 tasks).",
  ])("treats %s as a success", (output) => {
    expect(toolErrorMessage(parseToolOutput(output))).toBeNull();
  });
});

describe("pickTitleField", () => {
  it("skips a multi-line body in favor of a single-line title", () => {
    expect(pickTitleField({ content: "line one\nline two", name: "notes.md" })).toEqual({
      key: "name",
      value: "notes.md",
    });
    expect(pickTitleField({ id: 1 })).toBeNull();
  });
});

describe("statusTone", () => {
  it.each([
    ["completed", "success"],
    ["In_Progress", "active"],
    ["FAILED", "failure"],
    ["not-started", "neutral"],
    ["constructor", "neutral"],
  ])("%s -> %s", (status, tone) => {
    expect(statusTone(status)).toBe(tone);
  });

  it("labels a status as words", () => {
    expect(statusLabel("in_progress")).toBe("in progress");
  });
});

describe("isoTimestampMs", () => {
  it("parses ISO date-times only", () => {
    expect(isoTimestampMs("2026-10-27T09:00:00-07:00")).toBe(Date.parse("2026-10-27T16:00:00Z"));
    expect(isoTimestampMs("2026-10-24T18:02:11.123Z")).not.toBeNull();
    expect(isoTimestampMs("2026-10-27")).toBeNull();
    // Date.parse would roll these into the next month.
    expect(isoTimestampMs("2026-02-30T10:00:00Z")).toBeNull();
    expect(isoTimestampMs("2026-13-01T10:00:00Z")).toBeNull();
    expect(isoTimestampMs("tomorrow at 9")).toBeNull();
  });
});

describe("isProseText", () => {
  const description =
    "Follow-up to [#11607](<https://github.com/o/r/pull/11607>).\n\n1. Show counts";

  it("treats a description-like field as prose", () => {
    expect(isProseText("Line one\nline two", "description")).toBe(true);
    expect(isProseText("Fix the bug\n\nDetails here", "commitMessage")).toBe(true);
    expect(isProseText("Use `Array<T>` here\nand there", "notes")).toBe(true);
    expect(isProseText("[1] See the RFC.\n\nMore notes", "description")).toBe(true);
    const withSample =
      "Steps:\n\n- Build\n    - web\n    - server\n- Ship\n\n```ts\nconst a = 1;\nif (a) {\n  run();\n}\n```\n";
    expect(isProseText(withSample, "description")).toBe(true);
  });

  it("keeps source, commands, edits and output in the code face", () => {
    // WHY: a file's content or a script must keep its exact layout, even if it holds `# comments`.
    expect(isProseText("# Title\n- item", "content")).toBe(false);
    expect(isProseText("- a\n- b", "new_string")).toBe(false);
    expect(isProseText("SELECT *\nFROM t", "sql")).toBe(false);
    for (const key of ["oldText", "newText", "old_str", "new_str", "file_text", "output", "log"]) {
      expect(isProseText("## Setup\n\n- Run **the app**\n", key)).toBe(false);
    }
  });

  it("keeps data, markup and stack traces literal under a prose field name", () => {
    expect(isProseText('{\n  "error": "bad"\n}', "body")).toBe(false);
    expect(isProseText("[\n  true,\n  false\n]", "body")).toBe(false);
    expect(isProseText("[null, 1]\n", "body")).toBe(false);
    expect(isProseText("<html>\n<body>Hi</body>\n</html>", "body")).toBe(false);
    expect(isProseText("Follow these.\n<instructions>\nBe brief\n</instructions>", "prompt")).toBe(
      false,
    );
    expect(isProseText("TypeError: x\n    at f (a.js:1)\n    at g (b.js:2)", "message")).toBe(
      false,
    );
  });

  it("reads markdown under an unknown field name as prose", () => {
    expect(isProseText(description, "text")).toBe(true);
    expect(isProseText("[#11607](https://x/pull/11607) follow-up\nmore", "text")).toBe(true);
    expect(isProseText("# Plan\n\n- first\n- second")).toBe(true);
    expect(isProseText("See **this** part\n- and more")).toBe(true);
  });

  it("does not read plain text, code, logs or JSON as markdown", () => {
    expect(isProseText("line one\nline two")).toBe(false);
    expect(isProseText("# install deps\npip install x\n# run\nmake")).toBe(false);
    expect(isProseText("Collected 3 items\n- a passed\n- b passed")).toBe(false);
    expect(isProseText("function f() {\n  return 1;\n}\n# not a heading")).toBe(false);
    expect(isProseText('{\n  "a": "[x](y)"\n}')).toBe(false);
    expect(isProseText('["a", "[x](y)"]')).toBe(false);
    expect(isProseText("def f():\n    return 1\n    # [x](y)")).toBe(false);
  });
});
