# Separate paired-tremolo provider candidate

`tremolo_provider_candidate_spec.py` writes an immutable-input build specification
for `ourtextscores-ots-homr-tremolo-candidate`, revision
`ots-homr-tremolo-candidate-20261007-v1`. It performs no deployment and does not
import or alter the shipping Modal image definition. This is a build specification,
not an already built or deployable Modal application.

Generate it with an existing Python environment:

```sh
python tremolo_provider_candidate_spec.py \
  --manifest /absolute/path/to/local-candidate/candidate.json \
  --output /absolute/path/to/provider-build-spec.json
```

The output is created exclusively, refusing to overwrite a previous receipt.
The generator verifies the source archive, ordered runtime glue/tremolo/head-routing
patches, all installed runtime Python sources, the three accepted fp32 graphs and
segmentation graph. It rejects missing/extra runtime Python files, altered graphs,
shipping fp16 encoder identities, or unqualified head masks. Service implementation
hashes are captured from the current checkout: those inputs must accompany the
candidate image, rather than silently taking service code from another checkout.

Both worker roles require the corrected head-routing patch. The core worker uses
an empty sidecar path and `none` export mask. The additional-heads worker uses the
explicit verified sidecar path and `beam,stem,tie,slur`. Rhythmic advance remains
excluded. Paired timing has explicit disabled and enabled arms, independent of an
ambient runtime environment variable. The separate application's capabilities must
report its own revision, graph/source identities and actual notation policy; it
must not claim the existing shipping model pins.

The current successful receipt is local:
`/home/jhlusko/workspace/homr-artifacts/local-tremolo-service-20261007-v2/provider-build-spec.json`.
It references the same experimentally qualified fp32 stack as the v2 HTTP scans.
The current private Modal fp16 stack has different hashes and requires a separate
accuracy/policy check. Neither graph replacement nor a new model publication is
performed by this tool.

A future separate image builder must copy the verified runtime tree and service
inputs, preserve the reviewed dependency/CUDA recipe, and construct workers with
the explicit settings in the receipt. Do not merely set the timing flag on the
old shipping image. The existing `local_tremolo_candidate.py` remains the working
CPU HTTP qualification harness; this specification does not add OCR or text
fusion to that harness.

Remaining gates are fresh negative controls, the separate image build, actual
production-compatible GPU execution, OCR/calibrated text fusion, and full per-page
latency against the 280-second deadline. No production provider revision or backend
`.env` should change before those gates pass. App/revision names reserve a distinct
candidate namespace; they do not establish deployment or readiness.

## Executable private-fp16 image recipe

`modal_tremolo_candidate.py` is a separate executable Modal entrypoint. Its app is
`ourtextscores-ots-homr-tremolo-private-fp16-candidate-on`, revision
`ots-homr-tremolo-private-fp16-candidate-20261007-v1-on`, with dedicated volume
`ots-homr-tremolo-candidate-models`. It has **not been imported, built or deployed**.
Importing this entrypoint constructs Modal resource definitions; offline tests parse
its AST instead. The shipping `modal_app.py` and volume remain unchanged.

This recipe intentionally bootstraps the existing private fp16 pins. It does not
load the experimental fp32 graphs used by the successful local receipts. Candidate
identity retains the actual model pins and adds an explicit unqualified graph-family
warning, all four immutable source input hashes, exact worker family masks, and
hashes of copied service/support Python, JSON, dependency text and PNG inputs.
Image build steps verify those copied inputs before runtime. The checkout commit
and exact input hashes are complementary: an uncommitted local file is not falsely
claimed to equal that checkout commit.

The pinned CUDA base and dependency recipe are carried over from the shipping
builder. The recipe additionally checks all three patch hashes before ordered clean
application. It wraps `PatchedHomrCore`'s worker factory to distinguish empty/plain
from explicit/head sidecar paths and sets the accepted masks. Paired timing is
explicitly enabled only in this candidate image. Fusion defaults off and retains
the existing missing/incompatible-calibration rejection when enabled.

Eleven offline tests cover specification rejection, worker masks, actual-pin identity
preservation and AST builder separation/hash checks. These tests establish source
configuration, not CUDA readiness, Modal dependency availability, model accuracy or
latency. A separate build and full fp16 qualification are still required before this
candidate can be promoted. No model publication, backend environment update or live
resource creation has occurred.

The dedicated build input `OTS_CANDIDATE_PAIRED_TREMOLO_TIMING` accepts only `0`
or `1` (default `1`). It is baked into the image; value `0` reserves a distinct
`-off` app and service revision for the disabled control. Runtime candidate
provenance records the actual timing setting. Both arms use the candidate-only
volume namespace. Offline tests replace the entire Modal module with a recorder,
execute the real image recipe, inspect copy/hash/environment/decorator calls, and
check both arms without creating live resources. Worker-factory tests preserve
both timing values alongside the explicit masks.
