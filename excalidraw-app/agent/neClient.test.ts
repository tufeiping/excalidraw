import { AI_CONFIG_STORAGE_KEY } from "../aiConfig";

import { getNeSession, invalidateNeSession } from "./neClient";
import { chatCompletion } from "./provider";

/**
 * The relay answers 401 for two very different situations. Collapsing them into
 * "please sign in" sent people who *were* signed in toward a login they had
 * already done, so the reason the relay returns is carried through untouched.
 */

const replyWith = (status: number, body: unknown) => {
  global.fetch = vi
    .fn()
    .mockResolvedValue(
      new Response(JSON.stringify(body), { status }),
    ) as unknown as typeof fetch;
};

beforeEach(() => {
  invalidateNeSession();
  localStorage.clear();
});

describe("relay refusal reasons", () => {
  it("keeps `ne_not_linked` distinct from `not_logged_in`", async () => {
    replyWith(401, { ok: false, reason: "ne_not_linked" });
    const session = await getNeSession({ force: true });
    expect(session).toEqual({ ok: false, reason: "ne_not_linked" });
  });

  it("keeps `reauth_required`", async () => {
    replyWith(401, { ok: false, reason: "reauth_required" });
    const session = await getNeSession({ force: true });
    expect(session).toEqual({ ok: false, reason: "reauth_required" });
  });

  it("falls back to `unavailable` for an unknown reason", async () => {
    replyWith(401, { ok: false, reason: "something_new" });
    const session = await getNeSession({ force: true });
    expect(session).toEqual({ ok: false, reason: "unavailable" });
  });

  it("survives a non-JSON body", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response("<html>login</html>", { status: 401 }),
      ) as unknown as typeof fetch;
    const session = await getNeSession({ force: true });
    expect(session).toEqual({ ok: false, reason: "unavailable" });
  });

  it("tells an NE-less account to link NE, not to log in again", async () => {
    localStorage.setItem(
      AI_CONFIG_STORAGE_KEY,
      JSON.stringify({
        mode: "ne",
        custom: { preset: "deepseek", baseUrl: "", model: "", apiKey: "" },
        ne: { model: "" },
      }),
    );
    replyWith(401, { ok: false, reason: "ne_not_linked" });

    await expect(
      chatCompletion({ messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toThrow(/NE/);
  });
});
