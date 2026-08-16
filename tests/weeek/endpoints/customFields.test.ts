import { describe, it, expect } from "vitest";
import { listCustomFields } from "../../../src/weeek/endpoints/customFields.js";
import { WeeekError } from "../../../src/weeek/types.js";
import { makeMockWeeekClient } from "../../helpers/mockWeeekClient.js";
import {
  makeEnvelope,
  makeCustomFieldPayload,
  FIXTURE_MR_FIELD_UUID,
} from "../../helpers/factories.js";
import { silenceShapeWarn } from "../../helpers/shapeWarn.js";
import { WEEEK_PATH } from "../../helpers/paths.js";

// I8 (#47) — the workspace's custom-field definitions, read for ONE purpose:
// resolving an MR-link field's name to its id inside `weeek_set_task_mr_link`.
// No listing tool is exposed (ADR 0005 §4), so this parser has no tool test
// above it and is covered here alone.
describe("listCustomFields", () => {
  silenceShapeWarn();

  it("GETs /tm/custom-fields and unwraps the `data` array", async () => {
    // The envelope key is `data`, not `customFields` — the published spec
    // documents this endpoint as an empty object and probe #12 found otherwise.
    const m = makeMockWeeekClient();
    m.whenRequest("GET", WEEEK_PATH.customFieldsList, {
      status: 200,
      body: makeEnvelope("data", [
        makeCustomFieldPayload(),
        makeCustomFieldPayload({
          id: "9b1d0000-0000-4000-8000-000000000002",
          name: "Estimate",
          type: "number",
        }),
      ]),
    });
    const out = await listCustomFields(m.client);
    expect(m.requests()).toEqual([
      { method: "GET", path: WEEEK_PATH.customFieldsList },
    ]);
    expect(out).toEqual([
      { id: FIXTURE_MR_FIELD_UUID, name: "MR link", type: "link" },
      {
        id: "9b1d0000-0000-4000-8000-000000000002",
        name: "Estimate",
        type: "number",
      },
    ]);
  });

  it("the id is carried as a STRING, never coerced to a number", async () => {
    // The load-bearing typing difference from every other id on this surface
    // (board / column / project / task are integers). A numeric coerce here
    // would produce `NaN` and a write to a field that does not exist.
    const m = makeMockWeeekClient();
    m.whenRequest("GET", WEEEK_PATH.customFieldsList, {
      status: 200,
      body: makeEnvelope("data", [makeCustomFieldPayload()]),
    });
    const out = await listCustomFields(m.client);
    expect(typeof out[0]?.id).toBe("string");
    expect(out[0]?.id).toBe(FIXTURE_MR_FIELD_UUID);
  });

  it("a tenant with no custom fields returns [] (the documented empty case)", async () => {
    const m = makeMockWeeekClient();
    m.whenRequest("GET", WEEEK_PATH.customFieldsList, {
      status: 200,
      body: makeEnvelope("data", []),
    });
    expect(await listCustomFields(m.client)).toEqual([]);
  });

  it.each<[string, unknown]>([
    ["id", ""],
    ["name", ""],
    ["type", ""],
  ])(
    "missing required field `%s` degrades to its typed default (ADR 0003)",
    async (field, expected) => {
      const row = makeCustomFieldPayload();
      delete row[field];
      const m = makeMockWeeekClient();
      m.whenRequest("GET", WEEEK_PATH.customFieldsList, {
        status: 200,
        body: makeEnvelope("data", [row]),
      });
      const out = await listCustomFields(m.client);
      expect(out[0]).toHaveProperty(field, expected);
    },
  );

  it("present-but-non-array `data` degrades to [] (no throw)", async () => {
    // The spec's documented shape for this endpoint is literally an empty
    // object. If a tenant ever answers with one, resolution must degrade to
    // "no field defined" rather than erroring the tool.
    const m = makeMockWeeekClient();
    m.whenRequest("GET", WEEEK_PATH.customFieldsList, {
      status: 200,
      body: makeEnvelope("data", { not: "array" }),
    });
    expect(await listCustomFields(m.client)).toEqual([]);
  });

  it("drops a non-object entry, keeping its siblings", async () => {
    const m = makeMockWeeekClient();
    m.whenRequest("GET", WEEEK_PATH.customFieldsList, {
      status: 200,
      body: makeEnvelope("data", [makeCustomFieldPayload(), 42]),
    });
    expect(await listCustomFields(m.client)).toHaveLength(1);
  });

  it("envelope negatives still throw (success:false)", async () => {
    const m = makeMockWeeekClient();
    m.whenRequest("GET", WEEEK_PATH.customFieldsList, {
      status: 200,
      body: { success: false },
    });
    await expect(listCustomFields(m.client)).rejects.toBeInstanceOf(WeeekError);
  });

  it("a plan-tier gate (403) surfaces as weeek_forbidden, not an empty list", async () => {
    // Custom fields may be plan-gated on some tenants (ADR 0005 §5). That must
    // reach the caller as the refusal it is — degrading it to `[]` would make
    // the tool report "no MR-link field is defined" for a workspace that has
    // one and merely would not show it.
    const m = makeMockWeeekClient();
    m.whenRequest("GET", WEEEK_PATH.customFieldsList, {
      status: 403,
      body: { success: false },
    });
    await expect(listCustomFields(m.client)).rejects.toMatchObject({
      code: "weeek_forbidden",
      status: 403,
    });
  });
});
