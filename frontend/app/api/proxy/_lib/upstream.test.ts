import { withTraceHeaders } from "./upstream";

describe("withTraceHeaders", () => {
  it("forwards tracing and session headers from inbound request", () => {
    const request = {
      headers: new Headers({
        "x-request-id": "req-123",
        "x-trace-id": "trace-123",
        "traceparent": "00-1234567890abcdef1234567890abcdef-1234567890abcdef-01",
        "x-client-session-id": "session-abc",
      }),
    } as Request;

    const merged = withTraceHeaders(request, { "content-type": "application/json" });

    expect(merged.get("content-type")).toBe("application/json");
    expect(merged.get("x-request-id")).toBe("req-123");
    expect(merged.get("x-trace-id")).toBe("trace-123");
    expect(merged.get("traceparent")).toBe("00-1234567890abcdef1234567890abcdef-1234567890abcdef-01");
    expect(merged.get("x-client-session-id")).toBe("session-abc");
  });

  it("does not overwrite explicitly provided outbound headers", () => {
    const request = {
      headers: new Headers({
        "x-client-session-id": "session-inbound",
      }),
    } as Request;

    const merged = withTraceHeaders(request, {
      "x-client-session-id": "session-explicit",
      "x-session-id": "session-explicit",
    });

    expect(merged.get("x-client-session-id")).toBe("session-explicit");
    expect(merged.get("x-session-id")).toBe("session-explicit");
  });
});
