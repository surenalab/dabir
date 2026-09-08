# Score Anchoring: Consistent Guidance for Diffusion Posterior Sampling

Read this first. It is the paper's identity, its conventions and how its code runs. Keep it short; agents and humans both maintain it.

## Identity
Diffusion posterior sampling drifts when the guidance gradient and the learned score disagree at low noise levels. We introduce score anchoring, a single scalar correction that keeps the guided trajectory within a trust region of the prior score. On sparse-view CT and accelerated MRI it holds a 1.8 dB PSNR margin over three baselines across noise levels up to $\sigma = 0.3$, with no extra network evaluations.

Document class `IEEEtran`. Main file `main.tex`. Structure: Introduction · Method · Results · Conclusion.

## Claims and key numbers
(One line per claim with the number that supports it and the artefact it comes from.)

## Conventions
Notation and macros that must not be redefined:
- `\newcommand{\norm}[1]{\left\lVert #1 \right\rVert}`
- `\newcommand{\score}{s_\theta}`

## Repo map
- `code/sweep.py`: Noise sweep that produces figures/psnr-vs-noise.pdf and tables/psnr-sweep.tex.

## How to run
(No environment file found. Add one, or set `prefix` in `dabir.toml [env]`.)
No environment prefix set in `dabir.toml [env]`; commands run as written, for example `python code/script.py`.

## Generated artefacts
| Artefact | Made by |
|---|---|
| figures/psnr-vs-noise.pdf | `python3 code/sweep.py --sigma 0.3` |
| tables/psnr-sweep.tex | `python3 code/sweep.py --sigma 0.3` |

Never hand-edit these or numbers copied from them. Rerun the command (skill: rerun-experiment).

## Working rules
- Smallest change that does the job. One concern per run.
- Compile before you finish (skill: compile-and-fix).
- Record durable decisions as one fact per file in `.dabir/memory/`, with `name` and `description` frontmatter.
- Skills for the recurring jobs are in `.dabir/skills/`.
