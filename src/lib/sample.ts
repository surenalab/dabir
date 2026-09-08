// Bundled sample so the shell renders in a plain browser (no Tauri).
// Mirrors examples/score-anchor in the repo.

import type { Project } from "./backend";

const root = "/examples/score-anchor";

export const SAMPLE_FILES: Record<string, string> = {
  [`${root}/main.tex`]: `\\documentclass[journal]{IEEEtran}
\\usepackage{amsmath,amssymb,graphicx,booktabs}
\\newcommand{\\norm}[1]{\\left\\lVert #1 \\right\\rVert}
\\newcommand{\\score}{s_\\theta}

\\title{Score Anchoring: Consistent Guidance for Diffusion Posterior Sampling}
\\author{Aurelio Vantreight \\and Ilse Marrowfield \\and Teodor Quenzel}

\\begin{document}
\\maketitle

\\begin{abstract}
Diffusion posterior sampling drifts when the guidance gradient and the learned score disagree at low noise levels. We introduce score anchoring, a single scalar correction that keeps the guided trajectory within a trust region of the prior score. On sparse-view CT and accelerated MRI it holds a 1.8 dB PSNR margin over three baselines across noise levels up to $\\sigma = 0.3$, with no extra network evaluations.
\\end{abstract}

\\section{Introduction}
Reconstructing an image from incomplete measurements is ill-posed unless the prior closes the gap left by the forward operator~\\cite{okonkwo2021,lindqvist2022}. Diffusion models are now the prior of choice, but guided sampling can wander far from the data manifold when the likelihood term dominates~\\cite{morales2023}. We ask a narrow question: how far may the guidance move a sample before the score stops being trustworthy?

\\section{Method}
\\subsection{Forward model and prior}
Let $x \\in \\mathbb{R}^n$ be the unknown image and $y = A x + \\eta$ the measurement with $\\eta \\sim \\mathcal{N}(0, \\sigma^2 I)$. A pretrained score network $\\score(x_t, t)$ approximates $\\nabla \\log p_t(x_t)$ along the noising process.

\\subsection{Score anchoring}
At each reverse step we compare the guidance gradient $g_t = \\nabla_{x_t} \\norm{y - A \\hat{x}_0(x_t)}_2^2$ with the prior score and clip its contribution to a trust region:
\\begin{equation}
  \\tilde{g}_t = g_t \\cdot \\min\\!\\left(1, \\frac{\\kappa \\norm{\\score(x_t, t)}_2}{\\norm{g_t}_2}\\right)
  \\label{eq:anchor}
\\end{equation}
The anchor ratio $\\kappa$ is the only new hyperparameter. Equation~\\eqref{eq:anchor} costs one norm per step and no extra evaluations of $\\score$; see Section~\\ref{sec:results} for its effect.

\\subsection{Sampler}
\\label{sec:sampler}
We plug $\\tilde{g}_t$ into a standard predictor--corrector sampler. Figure~\\ref{fig:psnr} reports PSNR against noise level for three baselines; anchoring holds a 1.8 dB margin up to $\\sigma = 0.3$.

\\begin{figure}[t]
  \\centering
  \\includegraphics[width=\\linewidth]{figures/psnr-vs-noise.pdf}
  \\caption{PSNR against noise level $\\sigma$ on the sparse-view CT validation set. Shaded bands are one standard deviation over five seeds.}
  \\label{fig:psnr}
\\end{figure}

\\section{Results}
\\label{sec:results}
\\input{tables/psnr-sweep}
Across all noise levels the anchored sampler is the only method whose reconstructions remain sharp at $\\sigma = 0.3$; the unanchored baseline~\\cite{morales2023} collapses to streak artefacts above $\\sigma = 0.2$.

\\section{Conclusion}
A trust region on the guidance term is enough to keep diffusion posterior sampling well behaved at high noise. The code and the sweep that produced every figure are in the repository.

\\bibliographystyle{IEEEtran}
\\bibliography{refs}
\\end{document}
`,
  [`${root}/refs.bib`]: `@article{okonkwo2021,
  title={Generative priors for ill-posed inverse problems},
  author={Quillfeather, Odalys and Brannock-Sayle, Wendeline},
  journal={IEEE Trans. Comput. Imaging}, year={2021}
}
@inproceedings{lindqvist2022,
  title={Denoising diffusion models as image priors},
  author={Halvering, Corisande and Ostrowicz-Bell, Tamsin and Pellegrew, Ansel},
  booktitle={NeurIPS}, year={2022}
}
@inproceedings{morales2023,
  title={Posterior sampling with diffusion guidance for noisy inverse problems},
  author={Verhoeckx-Lind, Marisol and Dunstable, Barnaby and others},
  booktitle={ICLR}, year={2023}
}
`,
  [`${root}/code/sweep.py`]: `"""Noise sweep that produces figures/psnr-vs-noise.pdf and tables/psnr-sweep.tex.

Dependency-free on purpose so the sample runs anywhere: the reconstruction is
a toy model and the figure is written as a hand-built PDF.
"""
import argparse
import math
import random
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
METHODS = {"DPS": (33.5, 27.0), "Unanchored": (33.1, 28.5), "Anchored": (35.2, 26.5)}


def psnr(method: str, sigma: float, rng: random.Random) -> float:
    a, b = METHODS[method]
    return a - b * sigma + rng.gauss(0, 0.15)


def sweep(sigma_max: float, seeds: int):
    sigmas = [round(i * sigma_max / 6, 3) for i in range(7)]
    rows = {}
    for m in METHODS:
        rows[m] = []
        for s in sigmas:
            vals = [psnr(m, s, random.Random(hash((m, s, k)) & 0xFFFF)) for k in range(seeds)]
            rows[m].append(sum(vals) / seeds)
    return sigmas, rows


def write_table(sigmas, rows):
    out = ROOT / "tables" / "psnr-sweep.tex"
    lines = [
        "\\\\begin{table}[t]",
        "\\\\caption{PSNR (dB) by noise level. Generated by code/sweep.py; do not edit by hand.}",
        "\\\\label{tab:psnr}",
        "\\\\centering",
        "\\\\begin{tabular}{lccc}",
        "\\\\toprule",
        "$\\\\sigma$ & DPS & Unanchored & Anchored \\\\\\\\",
        "\\\\midrule",
    ]
    for i, s in enumerate(sigmas):
        if i % 2 == 0:
            continue
        lines.append(f"{s:.2f} & " + " & ".join(f"{rows[m][i]:.1f}" for m in METHODS) + " \\\\\\\\")
    lines += ["\\\\bottomrule", "\\\\end{tabular}", "\\\\end{table}", ""]
    out.write_text("\\n".join(lines))
    return out


def write_pdf(sigmas, rows):
    """A single-page PDF with axes and three polylines, no libraries."""
    W, H = 360, 240
    L, R, T, B = 48, 12, 12, 36
    ymin, ymax = 20, 40
    def X(s): return L + (s - sigmas[0]) / (sigmas[-1] - sigmas[0]) * (W - L - R)
    def Y(v): return B + (v - ymin) / (ymax - ymin) * (H - T - B)
    ops = [f"0.6 w 0.35 0.35 0.35 RG {L} {B} m {W-R} {B} l S {L} {B} m {L} {H-T} l S"]
    ops.append("BT /F1 8 Tf 0.3 0.3 0.3 rg")
    for s in sigmas[::2]:
        ops.append(f"1 0 0 1 {X(s)-6:.1f} {B-12} Tm ({s:.1f}) Tj")
    for v in range(ymin, ymax + 1, 5):
        ops.append(f"1 0 0 1 {L-22} {Y(v)-3:.1f} Tm ({v}) Tj")
    ops.append(f"1 0 0 1 {W/2-18:.1f} {B-24} Tm (noise \\\\(sigma\\\\)) Tj")
    ops.append(f"1 0 0 1 {L+4} {H-T-10} Tm (PSNR, dB) Tj ET")
    styles = {"DPS": "0.45 0.45 0.5 RG 1 w", "Unanchored": "0.65 0.65 0.7 RG 1 w [3 2] 0 d", "Anchored": "0.66 0.2 0.18 RG 1.6 w"}
    for m, style in styles.items():
        pts = " ".join(f"{X(s):.1f} {Y(v):.1f} {'m' if i == 0 else 'l'}" for i, (s, v) in enumerate(zip(sigmas, rows[m])))
        ops.append(f"q {style} {pts} S Q")
    ops.append("BT /F1 8 Tf")
    for i, (m, style) in enumerate(styles.items()):
        rgb = style.split(" RG")[0]
        ops.append(f"{rgb} rg 1 0 0 1 {W-R-92} {H-T-14-i*11} Tm ({m}) Tj")
    ops.append("ET")
    stream = zlib.compress("\\n".join(ops).encode())
    objs = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {W} {H}] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>".encode(),
        b"<< /Length " + str(len(stream)).encode() + b" /Filter /FlateDecode >>\\nstream\\n" + stream + b"\\nendstream",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    out = bytearray(b"%PDF-1.4\\n")
    offsets = []
    for i, o in enumerate(objs, 1):
        offsets.append(len(out))
        out += f"{i} 0 obj\\n".encode() + o + b"\\nendobj\\n"
    xref = len(out)
    out += f"xref\\n0 {len(objs)+1}\\n0000000000 65535 f \\n".encode()
    for off in offsets:
        out += f"{off:010d} 00000 n \\n".encode()
    out += f"trailer\\n<< /Size {len(objs)+1} /Root 1 0 R >>\\nstartxref\\n{xref}\\n%%EOF\\n".encode()
    path = ROOT / "figures" / "psnr-vs-noise.pdf"
    path.write_bytes(out)
    return path


def main(sigma_max: float, seeds: int = 5):
    sigmas, rows = sweep(sigma_max, seeds)
    fig = write_pdf(sigmas, rows)
    tab = write_table(sigmas, rows)
    print(f"swept {len(sigmas)} noise levels x {seeds} seeds")
    print(f"wrote {fig.relative_to(ROOT)} and {tab.relative_to(ROOT)}")


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--sigma", type=float, default=0.3)
    p.add_argument("--seeds", type=int, default=5)
    a = p.parse_args()
    main(a.sigma, a.seeds)
`,
  [`${root}/tables/psnr-sweep.tex`]: `\\begin{table}[t]
\\caption{PSNR (dB) by noise level. Generated by code/sweep.py; do not edit by hand.}
\\label{tab:psnr}
\\centering
\\begin{tabular}{lccc}
\\toprule
$\\sigma$ & DPS & Unanchored & Anchored \\\\
\\midrule
0.05 & 32.3 & 31.6 & 33.9 \\\\
0.15 & 29.6 & 28.8 & 31.2 \\\\
0.25 & 26.9 & 25.9 & 28.6 \\\\
\\bottomrule
\\end{tabular}
\\end{table}
`,
};

export const SAMPLE_PROJECT: Project = {
  root,
  name: "score-anchor",
  mainTex: `${root}/main.tex`,
  hasGit: true,
  hasMemory: true,
  tree: [
    { name: "code", path: `${root}/code`, kind: "dir", children: [
      { name: "sweep.py", path: `${root}/code/sweep.py`, kind: "code", children: [] },
    ]},
    { name: "figures", path: `${root}/figures`, kind: "dir", children: [
      { name: "psnr-vs-noise.pdf", path: `${root}/figures/psnr-vs-noise.pdf`, kind: "figure", children: [] },
    ]},
    { name: "tables", path: `${root}/tables`, kind: "dir", children: [
      { name: "psnr-sweep.tex", path: `${root}/tables/psnr-sweep.tex`, kind: "tex", children: [] },
    ]},
    { name: "dabir.toml", path: `${root}/dabir.toml`, kind: "data", children: [] },
    { name: "main.tex", path: `${root}/main.tex`, kind: "tex", children: [] },
    { name: "refs.bib", path: `${root}/refs.bib`, kind: "bib", children: [] },
  ],
};
