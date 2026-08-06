import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import ScannerClient from "./scanner-client";

describe("ScannerClient", () => {
  beforeEach(() => {
    global.fetch = jest.fn(
      async (_url: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "POST") {
          return {
            ok: true,
            json: async () => ({
              jobId: "job-multi",
              status: "succeeded",
              originalFilename: "page-2.png + 1 more",
              pageCount: 2,
              includedPageCount: 2,
              pages: [],
              hasMusicXml: true,
              hasPdf: true,
              hasThumbnail: true,
              hasZip: true,
              canRetry: false,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              resultExpiresAt: new Date().toISOString(),
            }),
          } as Response;
        }
        return { ok: true, json: async () => [] } as Response;
      },
    );
  });

  it("shows and submits multiple images in natural filename order", async () => {
    render(<ScannerClient />);
    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    const pageTen = new File(["ten"], "page-10.png", { type: "image/png" });
    const pageTwo = new File(["two"], "page-2.png", { type: "image/png" });
    fireEvent.change(screen.getByLabelText("Score files"), {
      target: { files: [pageTen, pageTwo] },
    });

    const order = screen.getByText("Initial page order").parentElement;
    expect(order).not.toBeNull();
    expect(
      within(order!)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual(["page-2.png", "page-10.png"]);

    const submit = screen.getByRole("button", { name: "Upload and review" });
    fireEvent.submit(submit.closest("form")!);
    await waitFor(() =>
      expect(global.fetch).toHaveBeenCalledWith(
        "/api/proxy/scanner/jobs",
        expect.objectContaining({ method: "POST" }),
      ),
    );
    const post = (global.fetch as jest.Mock).mock.calls.find(
      ([, init]) => init?.method === "POST",
    );
    const submitted = (post?.[1].body as FormData).getAll("file") as File[];
    expect(submitted.map((file) => file.name)).toEqual([
      "page-2.png",
      "page-10.png",
    ]);
  });
});
