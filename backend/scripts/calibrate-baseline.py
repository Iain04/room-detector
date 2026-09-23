"""Print backend environment settings from a labelled empty-room CSV capture."""

from pathlib import Path
import sys

import pandas as pd


if len(sys.argv) != 2:
    raise SystemExit("Usage: calibrate-baseline.py data/empty.csv")

capture = pd.read_csv(Path(sys.argv[1]))
valid = capture[
    (capture["reliable"].astype(str).str.lower() == "true")
    & (capture["calibrated"].astype(str).str.lower() == "true")
].copy()
baseline = pd.to_numeric(valid["baseline_diff"], errors="coerce").dropna()

if len(baseline) < 120:
    raise SystemExit("Need at least 120 calibrated, reliable readings in the empty-room capture.")

median = baseline.median()
tolerance = (baseline - median).abs().quantile(0.95)

print(f"# Derived from {len(baseline)} calibrated, reliable empty-room readings")
print(f"MOTION_BASELINE_DIFF_MEDIAN={median:.4f}")
print(f"MOTION_BASELINE_DIFF_TOLERANCE={tolerance:.4f}")
