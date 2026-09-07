# Injective Sampling for Generative Diffusion Priors in Computational Imaging

Read this first. It is the paper's identity, its conventions and how its code runs. Keep it short; agents and humans both maintain it.

## Identity
We study when a masked measurement operator admits a unique reconstruction under a diffusion prior. We give a density condition on the mask that guarantees injectivity on band-limited signals, and show that a lightweight guidance term recovers a 1.8 dB margin over three baselines across noise levels up to $\sigma = 0.3$.

Document class `IEEEtran`. Main file `main.tex`. Structure: Introduction · Method · Results · Conclusion.

## Claims and key numbers
(One line per claim with the number that supports it and the artefact it comes from.)

## Conventions
Notation and macros that must not be redefined:
- `\newcommand{\norm}[1]{\left\lVert #1 \right\rVert}`

## Repo map
- `code/sweep.py`: Noise sweep that produces figures/psnr-vs-noise.pdf and tables/psnr-sweep.tex.

## How to run
(No environment file found. Add one, or set `prefix` in `dabir.toml [env]`.)
No environment prefix set in `dabir.toml [env]`; commands run as written, for example `python code/script.py`.

## Generated artefacts
| Artefact | Made by |
|---|---|
| figures/psnr-vs-noise.pdf | `python code/sweep.py --sigma 0.3` |
| tables/psnr-sweep.tex | `python code/sweep.py --sigma 0.3` |

Never hand-edit these or numbers copied from them. Rerun the command (skill: rerun-experiment).

## Working rules
- Smallest change that does the job. One concern per run.
- Compile before you finish (skill: compile-and-fix).
- Record durable decisions as one fact per file in `.dabir/memory/`, with `name` and `description` frontmatter.
- Skills for the recurring jobs are in `.dabir/skills/`.
