import { describe, it, expect } from "vitest";
import { listMembers } from "../../../src/weeek/endpoints/members.js";
import { WeeekError } from "../../../src/weeek/types.js";
import { makeMockWeeekClient } from "../../helpers/mockWeeekClient.js";
import {
  makeEnvelope,
  makeMemberPayload,
} from "../../helpers/factories.js";
import { silenceShapeWarn } from "../../helpers/shapeWarn.js";
import { WEEEK_PATH } from "../../helpers/paths.js";

describe("listMembers", () => {
  silenceShapeWarn();

  it("happy: id is string (Weeek treats members differently from tasks/projects)", async () => {
    const m = makeMockWeeekClient();
    m.whenRequest("GET", WEEEK_PATH.membersList, {
      status: 200,
      body: makeEnvelope("members", [
        makeMemberPayload({ id: "u-1" }),
        makeMemberPayload({ id: "u-2", email: "x@y.z" }),
      ]),
    });
    const out = await listMembers(m.client);
    expect(out.map((x) => x.id)).toEqual(["u-1", "u-2"]);
  });

  it("firstName/lastName accept null (absent stays null, no warn)", async () => {
    const m = makeMockWeeekClient();
    m.whenRequest("GET", WEEEK_PATH.membersList, {
      status: 200,
      body: makeEnvelope("members", [
        makeMemberPayload({ firstName: null, lastName: null }),
      ]),
    });
    const out = await listMembers(m.client);
    expect(out[0]?.firstName).toBeNull();
    expect(out[0]?.lastName).toBeNull();
  });

  it("returns [] for an empty list", async () => {
    const m = makeMockWeeekClient();
    m.whenRequest("GET", WEEEK_PATH.membersList, {
      status: 200,
      body: makeEnvelope("members", []),
    });
    expect(await listMembers(m.client)).toEqual([]);
  });

  // --- I7.5 (#35) tolerant shaping: inner-field drift degrades, never throws.

  it("Gate F: a drifted string id degrades to \"\" — accepted sharp edge (ADR 0003)", async () => {
    // Member `id` is a string primary key; a wrong-typed / absent id degrades
    // to `""` rather than erroring the list. A poor value, but strictly better
    // than a full outage — and the warn-on-fallback makes it visible in logs.
    const m = makeMockWeeekClient();
    m.whenRequest("GET", WEEEK_PATH.membersList, {
      status: 200,
      body: makeEnvelope("members", [
        makeMemberPayload({ id: 42 as unknown as string }),
      ]),
    });
    const out = await listMembers(m.client);
    expect(out[0]?.id).toBe("");
  });

  it("Gate F: wrong-typed inner fields degrade, do not throw", async () => {
    const m = makeMockWeeekClient();
    m.whenRequest("GET", WEEEK_PATH.membersList, {
      status: 200,
      body: makeEnvelope("members", [
        // `id`/`email` wrong-typed → "", nullable names wrong-typed → null.
        makeMemberPayload({
          id: 7 as unknown as string,
          email: undefined,
          firstName: 7 as unknown as string,
          lastName: true as unknown as string,
        }),
      ]),
    });
    const out = await listMembers(m.client);
    expect(out).toEqual([
      { id: "", email: "", firstName: null, lastName: null },
    ]);
  });

  it.each<[string, unknown]>([
    ["id", ""],
    ["email", ""],
    ["firstName", null],
    ["lastName", null],
  ])(
    "missing field `%s` degrades to its typed default (no throw)",
    async (field, expected) => {
      const member = makeMemberPayload();
      delete member[field];
      const m = makeMockWeeekClient();
      m.whenRequest("GET", WEEEK_PATH.membersList, {
        status: 200,
        body: makeEnvelope("members", [member]),
      });
      const out = await listMembers(m.client);
      expect(out[0]).toHaveProperty(field, expected);
    },
  );

  it("present-but-non-array `members` degrades to [] (no throw)", async () => {
    const m = makeMockWeeekClient();
    m.whenRequest("GET", WEEEK_PATH.membersList, {
      status: 200,
      body: makeEnvelope("members", { not: "array" }),
    });
    expect(await listMembers(m.client)).toEqual([]);
  });

  it("drops a non-object entry, keeping its siblings", async () => {
    const m = makeMockWeeekClient();
    m.whenRequest("GET", WEEEK_PATH.membersList, {
      status: 200,
      body: makeEnvelope("members", [
        makeMemberPayload({ id: "keep-1" }),
        ["not", "an", "object"],
        makeMemberPayload({ id: "keep-2" }),
      ]),
    });
    const out = await listMembers(m.client);
    expect(out.map((x) => x.id)).toEqual(["keep-1", "keep-2"]);
  });

  it("envelope negatives still throw (success:false)", async () => {
    const m = makeMockWeeekClient();
    m.whenRequest("GET", WEEEK_PATH.membersList, {
      status: 200,
      body: { success: false },
    });
    await expect(listMembers(m.client)).rejects.toBeInstanceOf(WeeekError);
  });

  it("ignores extra fields like position/timeZone/logo", async () => {
    const m = makeMockWeeekClient();
    m.whenRequest("GET", WEEEK_PATH.membersList, {
      status: 200,
      body: makeEnvelope("members", [
        makeMemberPayload({ position: "lead", timeZone: "UTC", logo: "x" }),
      ]),
    });
    const out = await listMembers(m.client);
    expect(out[0]).toEqual({
      id: "u-1",
      email: "member@example.com",
      firstName: "Mem",
      lastName: "Ber",
    });
    expect(out[0]).not.toHaveProperty("position");
    expect(out[0]).not.toHaveProperty("timeZone");
    expect(out[0]).not.toHaveProperty("logo");
  });
});
