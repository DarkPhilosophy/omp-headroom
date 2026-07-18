import { describe, expect, test } from "bun:test";

import { modelUsesHeadroomProxy } from "../src/index.ts";

describe("upstream headroom wrap omp compatibility", () => {
  test("recognizes the project-prefixed Anthropic proxy endpoint", () => {
    expect(
      modelUsesHeadroomProxy(
        { baseUrl: "http://localhost:8787/p/my-project/anthropic" },
        "http://127.0.0.1:8787",
      ),
    ).toBe(true);
    expect(
      modelUsesHeadroomProxy(
        { baseUrl: "http://127.0.0.1:8787/anthropic/" },
        "http://localhost:8787",
      ),
    ).toBe(true);
  });

  test("does not suppress unrelated local or remote providers", () => {
    expect(
      modelUsesHeadroomProxy({ baseUrl: "http://127.0.0.1:8787/v1" }, "http://127.0.0.1:8787"),
    ).toBe(false);
    expect(
      modelUsesHeadroomProxy({ baseUrl: "https://api.anthropic.com" }, "http://127.0.0.1:8787"),
    ).toBe(false);
  });
});
