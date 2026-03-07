jest.mock("../../../../../_lib/proxy", () => ({
  buildScoreEditorOtsHeaders: jest.fn(),
  proxyScoreEditorOtsJson: jest.fn(),
}));

import {
  buildScoreEditorOtsHeaders,
  proxyScoreEditorOtsJson
} from "../../../../../_lib/proxy";
import { GET } from "./route";

const mockBuildScoreEditorOtsHeaders = buildScoreEditorOtsHeaders as jest.MockedFunction<typeof buildScoreEditorOtsHeaders>;
const mockProxyScoreEditorOtsJson = proxyScoreEditorOtsJson as jest.MockedFunction<typeof proxyScoreEditorOtsJson>;

describe("score-editor ots history route", () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockBuildScoreEditorOtsHeaders.mockResolvedValue(new Headers({ authorization: "Bearer token-123" }));
  });

  it("forwards source history requests to the helper with the correct upstream path", async () => {
    const request = {
      url: "http://localhost:3000/api/score-editor/ots/works/10/sources/s1/history?branch=feature-a",
      headers: new Headers()
    } as unknown as Request;
    mockProxyScoreEditorOtsJson.mockResolvedValue({ status: 200 } as Response);

    const response = await GET(request, { params: { workId: "10", sourceId: "s1" } });

    expect(mockProxyScoreEditorOtsJson).toHaveBeenCalledWith(
      request,
      "/works/10/sources/s1/history",
      {
        headers: expect.any(Headers)
      }
    );
    expect(response.status).toBe(200);
  });
});
