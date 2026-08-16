import { describe, it, expect } from "vitest";
import { listProjects } from "../../../src/weeek/endpoints/projects.js";
import { WeeekError } from "../../../src/weeek/types.js";
import { makeMockWeeekClient } from "../../helpers/mockWeeekClient.js";
import {
  makeEnvelope,
  makeProjectPayload,
} from "../../helpers/factories.js";
import { silenceShapeWarn } from "../../helpers/shapeWarn.js";
import { WEEEK_PATH } from "../../helpers/paths.js";

describe("listProjects", () => {
  silenceShapeWarn();

  it("maps a non-empty array to ProjectSummary[]", async () => {
    const m = makeMockWeeekClient();
    m.whenRequest("GET", WEEEK_PATH.projectsList, {
      status: 200,
      body: makeEnvelope("projects", [
        makeProjectPayload({ id: 1, title: "alpha" }),
        makeProjectPayload({ id: 2, title: "beta", isPrivate: true }),
      ]),
    });
    const out = await listProjects(m.client);
    expect(out).toEqual([
      { id: 1, title: "alpha", color: "#fff", isPrivate: false },
      { id: 2, title: "beta", color: "#fff", isPrivate: true },
    ]);
  });

  it("returns [] for an empty list", async () => {
    const m = makeMockWeeekClient();
    m.whenRequest("GET", WEEEK_PATH.projectsList, {
      status: 200,
      body: makeEnvelope("projects", []),
    });
    expect(await listProjects(m.client)).toEqual([]);
  });

  // --- I7.5 (#34) tolerant shaping: inner-field drift degrades, never throws.

  it("Gate F: a wrong-typed inner field degrades, does not throw", async () => {
    const m = makeMockWeeekClient();
    m.whenRequest("GET", WEEEK_PATH.projectsList, {
      status: 200,
      body: makeEnvelope("projects", [
        // `id` renamed away (absent), `color` wrong-typed, `isPrivate` wrong-typed.
        makeProjectPayload({ id: undefined, color: 123, isPrivate: "true" }),
      ]),
    });
    const out = await listProjects(m.client);
    expect(out).toEqual([
      { id: 0, title: "Alpha", color: "", isPrivate: false },
    ]);
  });

  it.each<[string, unknown]>([
    ["id", 0],
    ["title", ""],
    ["color", ""],
    ["isPrivate", false],
  ])(
    "missing required field `%s` degrades to its typed default (no throw)",
    async (field, expected) => {
      const project = makeProjectPayload();
      delete project[field];
      const m = makeMockWeeekClient();
      m.whenRequest("GET", WEEEK_PATH.projectsList, {
        status: 200,
        body: makeEnvelope("projects", [project]),
      });
      const out = await listProjects(m.client);
      expect(out[0]).toHaveProperty(field, expected);
    },
  );

  it("present-but-non-array `projects` degrades to [] (no throw)", async () => {
    const m = makeMockWeeekClient();
    m.whenRequest("GET", WEEEK_PATH.projectsList, {
      status: 200,
      body: makeEnvelope("projects", { not: "array" }),
    });
    expect(await listProjects(m.client)).toEqual([]);
  });

  it("drops a non-object entry, keeping its siblings (one bad row ≠ whole list)", async () => {
    const m = makeMockWeeekClient();
    m.whenRequest("GET", WEEEK_PATH.projectsList, {
      status: 200,
      body: makeEnvelope("projects", [
        makeProjectPayload({ id: 1, title: "keep-me" }),
        "not-an-object",
        makeProjectPayload({ id: 3, title: "also-keep" }),
      ]),
    });
    const out = await listProjects(m.client);
    expect(out).toEqual([
      { id: 1, title: "keep-me", color: "#fff", isPrivate: false },
      { id: 3, title: "also-keep", color: "#fff", isPrivate: false },
    ]);
  });

  it("one drifted field on one row leaves the sibling rows intact", async () => {
    const m = makeMockWeeekClient();
    m.whenRequest("GET", WEEEK_PATH.projectsList, {
      status: 200,
      body: makeEnvelope("projects", [
        makeProjectPayload({ id: 1, title: "good" }),
        makeProjectPayload({ id: 2, title: 999 }), // title drifted → ""
        makeProjectPayload({ id: 3, title: "also-good" }),
      ]),
    });
    const out = await listProjects(m.client);
    expect(out).toEqual([
      { id: 1, title: "good", color: "#fff", isPrivate: false },
      { id: 2, title: "", color: "#fff", isPrivate: false },
      { id: 3, title: "also-good", color: "#fff", isPrivate: false },
    ]);
  });

  it("envelope negatives still throw (success:false)", async () => {
    const m = makeMockWeeekClient();
    m.whenRequest("GET", WEEEK_PATH.projectsList, {
      status: 200,
      body: { success: false },
    });
    await expect(listProjects(m.client)).rejects.toBeInstanceOf(WeeekError);
  });

  it("ignores extra fields on entries (passthrough discipline)", async () => {
    const m = makeMockWeeekClient();
    m.whenRequest("GET", WEEEK_PATH.projectsList, {
      status: 200,
      body: makeEnvelope("projects", [
        makeProjectPayload({
          id: 7,
          title: "extra-fields",
          customFields: { foo: 1 },
          team: ["a", "b"],
        }),
      ]),
    });
    const out = await listProjects(m.client);
    expect(out).toEqual([
      { id: 7, title: "extra-fields", color: "#fff", isPrivate: false },
    ]);
    expect(out[0]).not.toHaveProperty("customFields");
    expect(out[0]).not.toHaveProperty("team");
  });
});
