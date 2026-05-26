import { describe, it, expect } from "vitest";
import { encodeInput } from "@/lib/browser-input-codec";
// The server-side decoder lives in JS (no transpile inside the agent
// container). This test pins the interop contract: bytes produced by the
// TS client codec must decode correctly via the JS server codec, since
// the two are independently maintained and could drift.
// @ts-expect-error — plain ESM module with no type defs
import { decode as decodeOnServer } from "../../agent/browser-service/input-codec.mjs";

function bytesOf(buf: ArrayBuffer | null): Uint8Array {
  if (!buf) throw new Error("encodeInput returned null");
  return new Uint8Array(buf);
}

describe("browser-input-codec cross-language interop", () => {
  it("TS encode → JS decode: mouseMove", () => {
    const bytes = bytesOf(encodeInput({ type: "mouseMove", x: 1234, y: 5678, buttons: 1 }));
    expect(decodeOnServer(bytes)).toEqual({
      type: "mouseMove",
      x: 1234,
      y: 5678,
      buttons: 1,
    });
  });

  it("TS encode → JS decode: mouseDown(left)", () => {
    const bytes = bytesOf(
      encodeInput({
        type: "mouseDown",
        x: 100,
        y: 200,
        button: "left",
        buttons: 1,
        clickCount: 1,
        modifiers: 0,
      }),
    );
    expect(decodeOnServer(bytes)).toEqual({
      type: "mouseDown",
      x: 100,
      y: 200,
      button: "left",
      buttons: 1,
      clickCount: 1,
      modifiers: 0,
    });
  });

  it("TS encode → JS decode: wheel with fractional deltas", () => {
    const bytes = bytesOf(
      encodeInput({ type: "wheel", x: 50, y: 60, deltaX: 1.5, deltaY: -2.25, buttons: 0 }),
    );
    const out = decodeOnServer(bytes);
    expect(out.type).toBe("wheel");
    expect(out.x).toBe(50);
    expect(out.y).toBe(60);
    expect(out.deltaX).toBeCloseTo(1.5, 5);
    expect(out.deltaY).toBeCloseTo(-2.25, 5);
    expect(out.buttons).toBe(0);
  });

  it("TS encode → JS decode: keyDown with multi-byte UTF-8", () => {
    const bytes = bytesOf(encodeInput({ type: "keyDown", key: "é", code: "KeyE", modifiers: 0 }));
    expect(decodeOnServer(bytes)).toEqual({
      type: "keyDown",
      key: "é",
      code: "KeyE",
      modifiers: 0,
    });
  });

  it("TS encode → JS decode: char with CJK", () => {
    const bytes = bytesOf(encodeInput({ type: "char", text: "日本語" }));
    expect(decodeOnServer(bytes)).toEqual({ type: "char", text: "日本語" });
  });

  it("TS encode → JS decode: right-click sequence", () => {
    const down = bytesOf(
      encodeInput({
        type: "mouseDown",
        x: 200,
        y: 150,
        button: "right",
        buttons: 2,
        clickCount: 1,
        modifiers: 0,
      }),
    );
    const up = bytesOf(
      encodeInput({
        type: "mouseUp",
        x: 200,
        y: 150,
        button: "right",
        buttons: 0,
        clickCount: 1,
        modifiers: 0,
      }),
    );
    expect(decodeOnServer(down)).toMatchObject({ type: "mouseDown", button: "right", buttons: 2 });
    expect(decodeOnServer(up)).toMatchObject({ type: "mouseUp", button: "right", buttons: 0 });
  });
});
