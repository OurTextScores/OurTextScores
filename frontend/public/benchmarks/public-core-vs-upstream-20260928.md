# Direct public-core versus upstream comparison — 2026-09-28

One common FP32 PyTorch inference path, native vocabularies, strict weight loading.
Identical staff crops and references; failures remain in the denominator.
Primary error rate is whole-symbol Levenshtein errors / reference symbols after removing numerator symbols.
Lower is better. Paired 95% bootstrap intervals resample complete scores (2,000 replicates).
This measures staff recognition, not detector quality or whole-page MusicXML correctness.

## ossq: 792 staves / 9 scores

| Model | Shared symbol error rate | Full symbol error rate | Pitch+accidental note error rate | Exact shared staves | Positional accuracy | Failed |
|---|---:|---:|---:|---:|---:|---:|
| upstream426 | 14.47% | 14.64% | 9.59% | 146/792 | 91.68% | 0 |
| pinned20260918 | 5.25% | 5.26% | 0.91% | 469/792 | 95.04% | 0 |
| public20260927 | 5.22% | 5.22% | 0.92% | 466/792 | 95.12% | 0 |

| Comparison | Shared error-rate change (pp) | Paired 95% CI |
|---|---:|---|
| public20260927_vs_upstream426 | -9.25 | -12.13 to -7.23 |
| pinned20260918_vs_upstream426 | -9.23 | -12.37 to -7.00 |
| public20260927_vs_pinned20260918 | -0.03 | -0.59 to +0.48 |

| Branch error rate | Upstream | Pinned OTS | Public core |
|---|---:|---:|---:|
| pitch | 2.85% | 0.61% | 0.62% |
| rhythm | 7.06% | 2.93% | 2.83% |
| lift | 5.52% | 0.90% | 0.91% |
| articulation | 3.28% | 2.12% | 2.11% |
| slur | 1.88% | 0.74% | 0.81% |
| position | 1.22% | 0.46% | 0.47% |

| Exact-position numerator | Upstream | Pinned OTS | Public core |
|---|---:|---:|---:|
| 5/x | 0/0 | 0/0 | 0/0 |
| 12/x | 0/0 | 0/0 | 0/0 |

## pdmx: 3422 staves / 632 scores

| Model | Shared symbol error rate | Full symbol error rate | Pitch+accidental note error rate | Exact shared staves | Positional accuracy | Failed |
|---|---:|---:|---:|---:|---:|---:|
| upstream426 | 7.44% | 8.44% | 7.32% | 1460/3422 | 84.27% | 0 |
| pinned20260918 | 4.52% | 4.57% | 4.07% | 2132/3422 | 88.62% | 0 |
| public20260927 | 4.69% | 4.75% | 4.47% | 2152/3422 | 88.17% | 0 |

| Comparison | Shared error-rate change (pp) | Paired 95% CI |
|---|---:|---|
| public20260927_vs_upstream426 | -2.75 | -3.81 to -1.95 |
| pinned20260918_vs_upstream426 | -2.92 | -4.05 to -2.03 |
| public20260927_vs_pinned20260918 | +0.17 | -0.40 to +0.74 |

| Branch error rate | Upstream | Pinned OTS | Public core |
|---|---:|---:|---:|
| pitch | 4.58% | 2.96% | 3.15% |
| rhythm | 4.46% | 2.70% | 2.90% |
| lift | 4.88% | 2.39% | 2.56% |
| articulation | 3.18% | 1.81% | 2.02% |
| slur | 3.53% | 2.09% | 2.28% |
| position | 3.15% | 1.71% | 1.92% |

| Exact-position numerator | Upstream | Pinned OTS | Public core |
|---|---:|---:|---:|
| 5/x | 0/84 | 48/84 | 45/84 |
| 12/x | 0/115 | 70/115 | 60/115 |

## lieder: 300 staves / 13 scores

| Model | Shared symbol error rate | Full symbol error rate | Pitch+accidental note error rate | Exact shared staves | Positional accuracy | Failed |
|---|---:|---:|---:|---:|---:|---:|
| upstream426 | 5.76% | 5.86% | 5.93% | 97/300 | 87.31% | 0 |
| pinned20260918 | 2.59% | 2.62% | 1.26% | 162/300 | 94.10% | 0 |
| public20260927 | 2.53% | 2.56% | 1.20% | 162/300 | 95.12% | 0 |

| Comparison | Shared error-rate change (pp) | Paired 95% CI |
|---|---:|---|
| public20260927_vs_upstream426 | -3.23 | -5.02 to -1.71 |
| pinned20260918_vs_upstream426 | -3.16 | -5.10 to -1.54 |
| public20260927_vs_pinned20260918 | -0.06 | -0.25 to +0.19 |

| Branch error rate | Upstream | Pinned OTS | Public core |
|---|---:|---:|---:|
| pitch | 2.17% | 0.78% | 0.74% |
| rhythm | 2.04% | 1.23% | 1.17% |
| lift | 3.53% | 0.75% | 0.74% |
| articulation | 1.41% | 0.63% | 0.64% |
| slur | 1.59% | 0.84% | 0.82% |
| position | 1.08% | 0.35% | 0.33% |

| Exact-position numerator | Upstream | Pinned OTS | Public core |
|---|---:|---:|---:|
| 5/x | 0/0 | 0/0 | 0/0 |
| 12/x | 0/2 | 1/2 | 1/2 |

Numerators are a vocabulary extension; report that capability separately from shared-symbol recognition.
The upstream native vocabulary includes natural signs. Historical claims to the contrary are not supported by this checkpoint.
Models were compared through the same current runtime, not against every upstream release.
Validation has been inspected before; these comparisons establish descriptive benchmark performance, not fresh test-set generalization.
Concurrent-job timings are not production-latency evidence. Public rebuild used 572 PDMX replay rows; planned GrandStaff replay was unavailable.
