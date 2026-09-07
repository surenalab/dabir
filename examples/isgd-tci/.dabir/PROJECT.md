# Project brief

Maintained by agents, reviewed by humans. Every vendor's instruction file points here.

## Claim
A density condition on the sampling mask makes diffusion-guided reconstruction well-posed on band-limited signals; a guidance term scaled by the injectivity constant keeps a 1.8 dB PSNR margin over DPS and Baseline B up to σ = 0.3.

## Venue
IEEE Transactions on Computational Imaging. 12 pages, IEEEtran journal class, two-column. No colour dependence in figures.

## Notation
- `\norm{x}` is the ℓ2 norm; defined in the preamble, do not redefine.
- A = M F: mask after Fourier transform. Keep the order.
- σ is measurement noise, never the diffusion schedule (that is β).

## Generated artefacts
| Artefact | Made by | Notes |
|---|---|---|
| figures/psnr-vs-noise.pdf | `python code/sweep.py --sigma 0.3` | 5 seeds, shaded band = 1 sd |
| tables/psnr-sweep.tex | same run | Do not edit by hand |

## How to run
```
python code/sweep.py --sigma 0.3
```
