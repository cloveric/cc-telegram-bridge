import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("control console responsive layout", () => {
  it("uses a dismissible instance drawer instead of a fixed-width mobile sidebar", async () => {
    const [app, styles] = await Promise.all([
      readFile(new URL("../web/src/App.tsx", import.meta.url), "utf8"),
      readFile(new URL("../web/src/styles.css", import.meta.url), "utf8"),
    ]);

    expect(app).toContain("aria-expanded={sidebarOpen}");
    expect(app).toContain('className={`sidebar${sidebarOpen ? " open" : ""}`}');
    expect(app).toContain('className="sidebar-backdrop"');
    expect(styles).toMatch(/@media \(max-width: 640px\)[\s\S]*\.sidebar\.open\s*{[\s\S]*transform:\s*translateX\(0\)/);
    expect(styles).toMatch(/\.sidebar-backdrop\s*{[^}]*inset:\s*0 0 0 min\(86vw, 320px\)/);
    expect(styles).not.toMatch(/@media \(max-width: 640px\)[\s\S]*\.sidebar\s*{[^}]*width:\s*220px/);
  });
});
