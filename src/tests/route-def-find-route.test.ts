import { describe, expect, test } from "bun:test";

// Importing the barrel server side-effect loads every `route()` definition
// (handlers register themselves in `routeRegistry` at import time). Without
// this, the registry is empty and `findRoute` always returns undefined.
import "../http/tasks";
import "../http/agents";
import "../http/sessions";

import { deriveSpanName, findRoute } from "../http/route-def";

describe("findRoute", () => {
  test("matches a parameterized GET /api/tasks/{id}", () => {
    const matched = findRoute("GET", ["api", "tasks", "abc-123"]);
    expect(matched).toBeDefined();
    expect(matched?.method).toBe("get");
    expect(matched?.path).toBe("/api/tasks/{id}");
  });

  test("matches the list endpoint GET /api/tasks", () => {
    const matched = findRoute("GET", ["api", "tasks"]);
    expect(matched).toBeDefined();
    expect(matched?.path).toBe("/api/tasks");
  });

  test("distinguishes verbs on the same path", () => {
    const got = findRoute("POST", ["api", "tasks"]);
    expect(got).toBeDefined();
    expect(got?.method).toBe("post");
    expect(got?.path).toBe("/api/tasks");
  });

  test("returns undefined for unknown paths", () => {
    expect(findRoute("GET", ["nope", "missing"])).toBeUndefined();
  });

  test("returns undefined for unknown methods on a known path", () => {
    // No PATCH handler on /api/tasks
    expect(findRoute("PATCH", ["api", "tasks"])).toBeUndefined();
  });

  test("returns undefined when method is missing", () => {
    expect(findRoute(undefined, ["api", "tasks"])).toBeUndefined();
  });
});

describe("deriveSpanName", () => {
  test("matched route produces `{METHOD} {template}` (with {id} placeholder, not a raw UUID)", () => {
    const name = deriveSpanName("GET", ["api", "tasks", "550e8400-e29b-41d4-a716-446655440000"]);
    expect(name).toBe("GET /api/tasks/{id}");
    // Cardinality guard: never embed raw IDs in the span name.
    expect(name).not.toContain("550e8400");
  });

  test("matched POST list endpoint", () => {
    expect(deriveSpanName("POST", ["api", "tasks"])).toBe("POST /api/tasks");
  });

  test("unmatched path falls back to `{METHOD} /{firstSegment}`", () => {
    // /health is a core route not declared via route(), so no template match.
    expect(deriveSpanName("GET", ["health"])).toBe("GET /health");
  });

  test("unmatched deeper path still only uses the first segment", () => {
    // Bounded cardinality: never `GET /mcp/<session-id>`.
    expect(deriveSpanName("POST", ["mcp", "session-xyz", "messages"])).toBe("POST /mcp");
  });

  test("root path produces bare method", () => {
    expect(deriveSpanName("GET", [])).toBe("GET");
  });

  test("missing method falls back to UNKNOWN", () => {
    expect(deriveSpanName(undefined, [])).toBe("UNKNOWN");
  });
});
