import { readFileSync } from "node:fs";
import type { Page } from "@playwright/test";

// UI-only mocks have no real login cookie; resource authorization is covered by
// content-resource server tests and the real-account browser tests.
export async function mockContentResources(page: Page) {
  await page.route("**/api/content-resources/*.json", async route => {
    const name = new URL(route.request().url()).pathname.split("/").pop()!;
    if (!["sentence-alignments.json", "cet4-writing.json", "cet6-writing.json"].includes(name)) {
      throw new Error(`Unexpected resource fixture ${name}`);
    }
    await route.fulfill({ contentType: "application/json", body: readFileSync(name, "utf8") });
  });
}
