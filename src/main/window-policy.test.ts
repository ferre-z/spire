import { describe, expect, it } from "vitest";
import { isAllowedPopoutUrl } from "./window-policy";

const DEV_SERVER = "http://localhost:5173";
const PACKAGED_POPOUT =
  "file:///opt/Spire/resources/app/.vite/renderer/main_window/popout.html";

describe("isAllowedPopoutUrl", () => {
  it("allows the dev-server popout page from the same origin", () => {
    expect(isAllowedPopoutUrl(`${DEV_SERVER}/popout.html`, DEV_SERVER, "main_window")).toBe(true);
  });

  it("allows the packaged popout page", () => {
    expect(isAllowedPopoutUrl(PACKAGED_POPOUT, undefined, "main_window")).toBe(
      true,
    );
  });

  it("denies external URLs", () => {
    expect(
      isAllowedPopoutUrl("https://example.com/popout.html", DEV_SERVER, "main_window"),
    ).toBe(false);
    expect(
      isAllowedPopoutUrl("https://example.com/", DEV_SERVER, "main_window"),
    ).toBe(false);
  });

  it("denies cross-origin dev URLs and other dev pages", () => {
    expect(
      isAllowedPopoutUrl("http://evil.local:5173/popout.html", DEV_SERVER, "main_window"),
    ).toBe(false);
    expect(
      isAllowedPopoutUrl(`${DEV_SERVER}/index.html`, DEV_SERVER, "main_window"),
    ).toBe(false);
    expect(
      isAllowedPopoutUrl(`${DEV_SERVER}/src/popout.html.evil`, DEV_SERVER, "main_window"),
    ).toBe(false);
  });

  it("denies other packaged pages and non-file protocols", () => {
    expect(
      isAllowedPopoutUrl(
        "file:///opt/Spire/resources/app/.vite/renderer/main_window/index.html",
        undefined,
        "main_window",
      ),
    ).toBe(false);
    expect(
      isAllowedPopoutUrl(
        "spire://renderer/main_window/popout.html",
        undefined,
        "main_window",
      ),
    ).toBe(false);
  });

  it("denies malformed URLs", () => {
    expect(isAllowedPopoutUrl("not a url", DEV_SERVER, "main_window")).toBe(false);
  });
});
