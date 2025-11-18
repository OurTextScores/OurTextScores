import { initSteps, applyEventToSteps, StepStatus } from "./progress-steps";

describe("progress-steps", () => {
  describe("initSteps", () => {
    it("should initialize the first step as active and the rest as pending", () => {
      const steps = initSteps();
      expect(steps[0].status).toBe("active");
      for (let i = 1; i < steps.length; i++) {
        expect(steps[i].status).toBe("pending");
      }
    });
  });

  describe("applyEventToSteps", () => {
    it("should update the status of a step and activate the next one", () => {
      const initialSteps = initSteps();
      const now = Date.now();
      const updatedSteps = applyEventToSteps(initialSteps, "upload.received", now);

      const receivedStep = updatedSteps.find(s => s.id === "upload.received");
      expect(receivedStep?.status).toBe("done");
      expect(receivedStep?.ms).toBeGreaterThanOrEqual(0);

      const nextStep = updatedSteps.find(s => s.id === "upload.stored");
      expect(nextStep?.status).toBe("active");
    });

    it("should handle fossil stages correctly", () => {
      const initialSteps = initSteps();
      const now = Date.now();

      // Test fossil failure
      const failedSteps = applyEventToSteps(initialSteps, "fossil.failed", now);
      const fossilStartFailed = failedSteps.find(s => s.id === "fossil.start");
      const fossilFailed = failedSteps.find(s => s.id === "fossil.failed");
      expect(fossilStartFailed?.status).toBe("failed");
      expect(fossilFailed?.status).toBe("failed");

      // Test fossil skipped
      const skippedSteps = applyEventToSteps(initialSteps, "fossil.skipped", now);
      const fossilStartSkipped = skippedSteps.find(s => s.id === "fossil.start");
      const fossilSkipped = skippedSteps.find(s => s.id === "fossil.skipped");
      expect(fossilStartSkipped?.status).toBe("skipped");
      expect(fossilSkipped?.status).toBe("skipped");
    });

    it("should not change steps for an unknown stage", () => {
      const initialSteps = initSteps();
      const now = Date.now();
      const updatedSteps = applyEventToSteps(initialSteps, "unknown.stage", now);
      expect(updatedSteps).toBe(initialSteps);
    });

    it("should handle variants correctly", () => {
      const initialSteps = initSteps();
      const now = Date.now();
      const updatedSteps = applyEventToSteps(initialSteps, "deriv.canonical", now);
      const mscz2mxlStep = updatedSteps.find(s => s.id === "deriv.mscz2mxl");
      expect(mscz2mxlStep?.status).toBe("done");
    });

    it("should mark pipeline.error as failed", () => {
      const initialSteps = initSteps();
      const now = Date.now();
      const updatedSteps = applyEventToSteps(initialSteps, "pipeline.error", now);
      const errorStep = updatedSteps.find(s => s.id === "pipeline.error");
      expect(errorStep?.status).toBe("failed");
    });
  });
});
