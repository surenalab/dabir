# Score Anchoring for Diffusion Posterior Sampling: Theory, Samplers and a Study Across Six Inverse Problems

Read this first. It is the paper's identity, its conventions and how its code runs. Keep it short; agents and humans both maintain it.

## Identity
Journal extension of the ISBI 2025 paper on score anchoring. Adds a contraction theorem, a sampler-agnostic formulation and a study on six inverse problems with five baselines. Target: IEEE Transactions on Computational Imaging.

Document class `IEEEtran`. Main file `main.tex`, which `\input`s `macros.tex`, `sections/*.tex` and `appendix/*.tex`. Structure: Introduction · Related work · Method · Theory · Experiments · Ablations · Discussion · Conclusion · Appendix A Proofs · Appendix B Additional results.

## Claims and key numbers
- 1.8 dB PSNR margin over the strongest baseline at $\sigma = 0.3$ (tables/main-results.tex, figures/psnr-vs-noise*.pdf).
- Plateau of the anchor ratio for $\kappa \in [0.5, 2]$ (figures/kappa-sweep.pdf).
- Anchoring costs about 0.3% wall-clock per step (tables/compute.tex).

## Conventions
Notation and macros live in `macros.tex` and must not be redefined: `\norm`, `\score`, `\anchor`, `\kap`, `\xhat`, `\meas`, `\fwd`, `\E`, `\R`. Cross-references use `\cref`/`\Cref` (cleveref), never bare `\ref`. British spelling throughout.

## Repo map
- `code/sweep.py`: Noise and kappa sweeps that produce every figure under figures/ and the generated tables.

## How to run
No environment prefix set in `dabir.toml [env]`; commands run as written, for example `python3 code/sweep.py --task ct --sigma 0.3`.

## Generated artefacts
| Artefact | Made by |
|---|---|
| figures/psnr-vs-noise*.pdf | `python3 code/sweep.py --task <ct|mri|deblur> --sigma 0.3` |
| figures/kappa-sweep.pdf | `python3 code/sweep.py --task ct --kappa-sweep` |
| tables/main-results.tex, tables/ssim.tex | `python3 code/sweep.py --all --sigma 0.1 [--metric ssim]` |

Never hand-edit these or numbers copied from them. Rerun the command (skill: rerun-experiment).

## Working rules
- Smallest change that does the job. One concern per run.
- Compile before you finish (skill: compile-and-fix).
- Record durable decisions as one fact per file in `.dabir/memory/`, with `name` and `description` frontmatter.
- Skills for the recurring jobs are in `.dabir/skills/`.
