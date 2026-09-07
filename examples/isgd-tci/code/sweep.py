"""Noise sweep that produces figures/psnr-vs-noise.pdf and tables/psnr-sweep.tex."""
import argparse
import numpy as np

def main(sigma_max: float, seeds: int = 5):
    sigmas = np.linspace(0.0, sigma_max, 7)
    # ... run reconstruction for each sigma and seed ...
    print(f"swept {len(sigmas)} noise levels x {seeds} seeds")

if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--sigma", type=float, default=0.2)
    main(p.parse_args().sigma)
