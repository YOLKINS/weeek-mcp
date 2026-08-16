import { describe, it, expect } from "vitest";
import { getMe } from "../../../src/weeek/endpoints/users.js";
import { WeeekError } from "../../../src/weeek/types.js";
import { makeMockWeeekClient } from "../../helpers/mockWeeekClient.js";
import {
  makeEnvelope,
  makeUserPayload,
} from "../../helpers/factories.js";
import { silenceShapeWarn } from "../../helpers/shapeWarn.js";
import { WEEEK_PATH } from "../../helpers/paths.js";

describe("getMe", () => {
  silenceShapeWarn();

  it("derives name from firstName + lastName", async () => {
    const m = makeMockWeeekClient();
    m.whenRequest("GET", WEEEK_PATH.userMe, {
      status: 200,
      body: makeEnvelope(
        "user",
        makeUserPayload({ firstName: "Anna", lastName: "Pak" }),
      ),
    });
    const out = await getMe(m.client);
    expect(out.name).toBe("Anna Pak");
    expect(out.id).toBe(1);
    expect(out.email).toBe("anna@example.com");
  });

  it("falls back to email when firstName and lastName are both null", async () => {
    const m = makeMockWeeekClient();
    m.whenRequest("GET", WEEEK_PATH.userMe, {
      status: 200,
      body: makeEnvelope(
        "user",
        makeUserPayload({
          firstName: null,
          lastName: null,
          email: "fallback@example.com",
        }),
      ),
    });
    const out = await getMe(m.client);
    expect(out.name).toBe("fallback@example.com");
  });

  it("explicit `name` field wins over derived parts", async () => {
    const m = makeMockWeeekClient();
    m.whenRequest("GET", WEEEK_PATH.userMe, {
      status: 200,
      body: makeEnvelope(
        "user",
        makeUserPayload({
          name: "Override Name",
          firstName: "X",
          lastName: "Y",
        }),
      ),
    });
    const out = await getMe(m.client);
    expect(out.name).toBe("Override Name");
  });

  it.each<[unknown]>([[123], ["abc"]])(
    "preserves the id number|string union (Weeek inconsistency)",
    async (id) => {
      const m = makeMockWeeekClient();
      m.whenRequest("GET", WEEEK_PATH.userMe, {
        status: 200,
        body: makeEnvelope("user", makeUserPayload({ id })),
      });
      const out = await getMe(m.client);
      expect(out.id).toBe(id);
    },
  );

  // --- I7.5 (#37) tolerant shaping: inner-field drift degrades, never throws.
  //     The two special semantics (id union, derived name) survive intact.

  it("Gate F: a drifted cosmetic field still yields a valid MeResponse (no throw)", async () => {
    // `firstName` arrives wrong-typed — a cosmetic drift. It degrades to `null`,
    // drops out of the derivation, and the record is still well-formed. A working
    // credential must never regress to `weeek_invalid_response` for this.
    const m = makeMockWeeekClient();
    m.whenRequest("GET", WEEEK_PATH.userMe, {
      status: 200,
      body: makeEnvelope(
        "user",
        makeUserPayload({ firstName: 42, lastName: "Pak" }),
      ),
    });
    const out = await getMe(m.client);
    expect(out).toEqual({ id: 1, email: "anna@example.com", name: "Pak" });
  });

  it("a drifted id (neither number nor string) degrades to 0 — accepted sharp edge (ADR 0003)", async () => {
    const m = makeMockWeeekClient();
    m.whenRequest("GET", WEEEK_PATH.userMe, {
      status: 200,
      body: makeEnvelope("user", makeUserPayload({ id: { nested: "object" } })),
    });
    const out = await getMe(m.client);
    expect(out.id).toBe(0);
  });

  it("missing id degrades to 0 (no throw)", async () => {
    const user = makeUserPayload();
    delete user["id"];
    const m = makeMockWeeekClient();
    m.whenRequest("GET", WEEEK_PATH.userMe, {
      status: 200,
      body: makeEnvelope("user", user),
    });
    const out = await getMe(m.client);
    expect(out.id).toBe(0);
    expect(out.email).toBe("anna@example.com");
  });

  it("missing email degrades to \"\" (no throw)", async () => {
    const user = makeUserPayload();
    delete user["email"];
    const m = makeMockWeeekClient();
    m.whenRequest("GET", WEEEK_PATH.userMe, {
      status: 200,
      body: makeEnvelope("user", user),
    });
    const out = await getMe(m.client);
    expect(out.email).toBe("");
  });

  it("a wrong-typed email degrades to \"\" (no throw)", async () => {
    const m = makeMockWeeekClient();
    m.whenRequest("GET", WEEEK_PATH.userMe, {
      status: 200,
      body: makeEnvelope("user", makeUserPayload({ email: 42 })),
    });
    const out = await getMe(m.client);
    expect(out.email).toBe("");
  });

  it("non-object `user` resource (array) still hard-throws — a detail cannot drop", async () => {
    const m = makeMockWeeekClient();
    m.whenRequest("GET", WEEEK_PATH.userMe, {
      status: 200,
      body: makeEnvelope("user", [1, 2, 3]),
    });
    let err: unknown;
    try {
      await getMe(m.client);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(WeeekError);
    expect((err as WeeekError).code).toBe("weeek_invalid_response");
  });

  it("401 from upstream propagates as weeek_unauthorized", async () => {
    const m = makeMockWeeekClient();
    m.whenRequest("GET", WEEEK_PATH.userMe, { status: 401, body: {} });
    let err: unknown;
    try {
      await getMe(m.client);
    } catch (e) {
      err = e;
    }
    const we = err as WeeekError;
    expect(we).toBeInstanceOf(WeeekError);
    expect(we.code).toBe("weeek_unauthorized");
    expect(we.status).toBe(401);
  });

  it("envelope without success:true → weeek_invalid_response", async () => {
    const m = makeMockWeeekClient();
    m.whenRequest("GET", WEEEK_PATH.userMe, {
      status: 200,
      body: { user: makeUserPayload() },
    });
    let err: unknown;
    try {
      await getMe(m.client);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(WeeekError);
    expect((err as WeeekError).code).toBe("weeek_invalid_response");
  });
});
