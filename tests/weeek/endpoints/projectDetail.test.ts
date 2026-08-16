import { describe, it, expect } from "vitest";
import { getProject } from "../../../src/weeek/endpoints/projectDetail.js";
import { WeeekError } from "../../../src/weeek/types.js";
import { makeMockWeeekClient } from "../../helpers/mockWeeekClient.js";
import {
  makeEnvelope,
  makeProjectDetailPayload,
} from "../../helpers/factories.js";
import { silenceShapeWarn } from "../../helpers/shapeWarn.js";
import { WEEEK_PATH } from "../../helpers/paths.js";

describe("getProject", () => {
  silenceShapeWarn();

  it("maps a single-object envelope to ProjectDetail", async () => {
    const m = makeMockWeeekClient();
    m.whenRequest("GET", WEEEK_PATH.projectById(7), {
      status: 200,
      body: makeEnvelope(
        "project",
        makeProjectDetailPayload({
          id: 7,
          title: "Alpha",
          description: "Q4 launch tracking",
        }),
      ),
    });
    const out = await getProject(m.client, 7);
    expect(out).toEqual({
      id: 7,
      title: "Alpha",
      description: "Q4 launch tracking",
      color: "#fff",
      isPrivate: false,
    });
  });

  it("preserves description: null", async () => {
    const m = makeMockWeeekClient();
    m.whenRequest("GET", WEEEK_PATH.projectById(1), {
      status: 200,
      body: makeEnvelope(
        "project",
        makeProjectDetailPayload({ id: 1, description: null }),
      ),
    });
    const out = await getProject(m.client, 1);
    expect(out.description).toBeNull();
  });

  // --- I7.5 (#34) tolerant shaping: inner-field drift degrades, never throws.

  it("Gate F: a wrong-typed / absent inner field degrades, does not throw", async () => {
    const m = makeMockWeeekClient();
    m.whenRequest("GET", WEEEK_PATH.projectById(1), {
      status: 200,
      body: makeEnvelope(
        "project",
        // `id` absent, `color` wrong-typed, `isPrivate` wrong-typed.
        makeProjectDetailPayload({ id: undefined, color: 7, isPrivate: 1 }),
      ),
    });
    const out = await getProject(m.client, 1);
    expect(out).toEqual({
      id: 0,
      title: "Alpha",
      description: "details",
      color: "",
      isPrivate: false,
    });
  });

  it.each<[string, unknown]>([
    ["id", 0],
    ["title", ""],
    ["color", ""],
    ["isPrivate", false],
    ["description", null],
  ])(
    "missing field `%s` degrades to its typed default (no throw)",
    async (field, expected) => {
      const project = makeProjectDetailPayload();
      delete project[field];
      const m = makeMockWeeekClient();
      m.whenRequest("GET", WEEEK_PATH.projectById(1), {
        status: 200,
        body: makeEnvelope("project", project),
      });
      const out = await getProject(m.client, 1);
      expect(out).toHaveProperty(field, expected);
    },
  );

  it("description of wrong type (number) degrades to null, not the scalar default", async () => {
    const m = makeMockWeeekClient();
    m.whenRequest("GET", WEEEK_PATH.projectById(1), {
      status: 200,
      body: makeEnvelope(
        "project",
        makeProjectDetailPayload({ description: 42 }),
      ),
    });
    const out = await getProject(m.client, 1);
    expect(out.description).toBeNull();
  });

  it("a non-object resource still throws (a detail cannot degrade to all-defaults)", async () => {
    // Arrays clear the envelope's `typeof === "object"` gate, so this reaches
    // the inner parser; ADR 0003 keeps it a hard error rather than emitting a
    // fully-synthetic ProjectDetail.
    const m = makeMockWeeekClient();
    m.whenRequest("GET", WEEEK_PATH.projectById(1), {
      status: 200,
      body: makeEnvelope("project", ["not", "an", "object"]),
    });
    await expect(getProject(m.client, 1)).rejects.toBeInstanceOf(WeeekError);
  });

  it("envelope negatives still throw (success:false)", async () => {
    const m = makeMockWeeekClient();
    m.whenRequest("GET", WEEEK_PATH.projectById(1), {
      status: 200,
      body: { success: false },
    });
    await expect(getProject(m.client, 1)).rejects.toBeInstanceOf(WeeekError);
  });

  it("ignores extra fields (passthrough discipline)", async () => {
    const m = makeMockWeeekClient();
    m.whenRequest("GET", WEEEK_PATH.projectById(7), {
      status: 200,
      body: makeEnvelope(
        "project",
        makeProjectDetailPayload({
          id: 7,
          title: "extra",
          logoLink: "https://cdn.example/img.png",
          team: ["u-1", "u-2"],
          customFields: [{ k: "v" }],
        }),
      ),
    });
    const out = await getProject(m.client, 7);
    expect(out).toEqual({
      id: 7,
      title: "extra",
      description: "details",
      color: "#fff",
      isPrivate: false,
    });
    expect(out).not.toHaveProperty("logoLink");
    expect(out).not.toHaveProperty("team");
    expect(out).not.toHaveProperty("customFields");
  });
});
