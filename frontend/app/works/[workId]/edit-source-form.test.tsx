import { describe, it, expect } from "@jest/globals";

describe("EditSourceForm", () => {
  it("exports EditSourceForm component", async () => {
    const editSourceFormModule = await import("./edit-source-form");
    expect(editSourceFormModule.default).toBeDefined();
  });

  it("EditSourceForm is a function", async () => {
    const editSourceFormModule = await import("./edit-source-form");
    expect(typeof editSourceFormModule.default).toBe("function");
  });
});
