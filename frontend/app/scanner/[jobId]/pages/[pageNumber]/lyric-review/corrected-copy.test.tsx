import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import CorrectedCopy from "./corrected-copy";
const notes = {
  musicXmlSha256: "xml-sha",
  notes: [
    {
      id: '["P1",4,2]',
      partId: "P1",
      measure: 4,
      measureLabel: "4",
      noteOrdinal: 2,
      onsetQuarterNotes: 1.5,
      pitch: "F5",
      voice: "1",
      staff: "1",
      occupiedLines: [],
    },
  ],
};
it("downloads a copy only after explicit syllable, printed-line and note confirmations", async () => {
  global.fetch = jest.fn(async (_url, options) =>
    options?.method === "POST"
      ? { ok: true, blob: async () => new Blob(["<score-partwise/>"]) }
      : { ok: true, json: async () => notes },
  ) as any;
  URL.createObjectURL = jest.fn(() => "blob:score");
  URL.revokeObjectURL = jest.fn();
  const click = jest
    .spyOn(HTMLAnchorElement.prototype, "click")
    .mockImplementation(() => {});
  render(
    <CorrectedCopy
      base="/api/proxy/scanner/jobs/job/pages/1/lyric-candidates"
      rasterSha256="raster-sha"
      candidates={[{ id: "c1", text: "fi-ne" }]}
    />,
  );
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Add reviewed syllable" }),
    ).toBeEnabled(),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Add reviewed syllable" }),
  );
  fireEvent.change(screen.getByLabelText("Correct syllable"), {
    target: { value: "fi" },
  });
  fireEvent.change(screen.getByLabelText("Recognised note"), {
    target: { value: notes.notes[0].id },
  });
  fireEvent.change(screen.getByLabelText("Printed lyric line"), {
    target: { value: "2" },
  });
  const download = screen.getByRole("button", {
    name: "Download corrected score copy",
  });
  expect(download).toBeDisabled();
  [
    "Syllable text confirmed",
    "Printed line confirmed",
    "Note placement confirmed",
  ].forEach((label) => fireEvent.click(screen.getByLabelText(label)));
  expect(download).toBeEnabled();
  fireEvent.change(screen.getByLabelText("Correct syllable"), {
    target: { value: "fine" },
  });
  expect(download).toBeDisabled();
  fireEvent.click(screen.getByLabelText("Syllable text confirmed"));
  fireEvent.click(download);
  await waitFor(() => expect(click).toHaveBeenCalled());
  const call = (global.fetch as jest.Mock).mock.calls.find(
    (c) => c[1]?.method === "POST",
  );
  expect(JSON.parse(call[1].body)).toMatchObject({
    automaticAttachment: false,
    rasterSha256: "raster-sha",
    musicXmlSha256: "xml-sha",
    placements: [
      {
        candidateId: "c1",
        text: "fine",
        noteId: notes.notes[0].id,
        printedLine: 2,
        textConfirmed: true,
        lineConfirmed: true,
        noteConfirmed: true,
      },
    ],
  });
  click.mockRestore();
});
