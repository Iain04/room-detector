"""Clean and compare one or more Wi-Fi CSI capture CSV files.

Usage:
    python scripts/plot_motion_comparison.py INPUT_CSV [INPUT_CSV ...] OUTPUT_PNG

Example:
    python scripts/plot_motion_comparison.py \
      data/empty.csv data/busy.csv data/busyClassRoom.csv \
      data/emptyToBusy.csv data/unknown.csv data/all-captures.png
"""

from pathlib import Path
import os
import re
import sys

os.environ.setdefault("MPLCONFIGDIR", str(Path.cwd() / ".matplotlib-cache"))
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import pandas as pd
import seaborn as sns


METRICS = ["motion_score", "motion_excess", "motion_max", "baseline_diff", "rssi", "packet_rate"]
MIN_PACKET_RATE = 50
BUCKET_SECONDS = 10


def label_from_path(path: Path) -> str:
    """Give common captures readable labels; use the filename for new captures."""
    names = {
        "empty": "Empty room",
        "busy": "Busy room",
        "busyclassroom": "Busy classroom",
        "busyemptybusyempty": "Busy → empty → busy → empty",
        "emptytobusy": "Empty to busy",
        "unknown": "Unknown capture",
    }
    stem = path.stem.lower()
    if stem in names:
        return names[stem]
    words = re.sub(r"([a-z])([A-Z])", r"\1 \2", path.stem).replace("_", " ").replace("-", " ")
    return words.title()


def as_boolean(series: pd.Series) -> pd.Series:
    return series.astype(str).str.strip().str.lower().isin(["true", "1", "yes"])


def load_and_clean(path: Path) -> tuple[pd.DataFrame, int]:
    """Load one capture, retaining calibrated and reliable decision-quality data."""
    raw = pd.read_csv(path)
    required = {"timestamp", "baseline_diff", "packet_rate", "calibrated", "reliable"}
    missing = required.difference(raw.columns)
    if missing:
        raise ValueError(f"missing columns: {', '.join(sorted(missing))}")

    frame = raw.copy()
    frame["timestamp"] = pd.to_datetime(frame["timestamp"], errors="coerce", utc=True)
    for metric in METRICS:
        frame[metric] = pd.to_numeric(frame.get(metric), errors="coerce")
    frame["calibrated"] = as_boolean(frame["calibrated"])
    frame["reliable"] = as_boolean(frame["reliable"])

    # Data cleaning: reject malformed, uncalibrated, unreliable, and weak-packet readings.
    frame = frame.loc[
        frame["timestamp"].notna()
        & frame["baseline_diff"].notna()
        & frame["calibrated"]
        & frame["reliable"]
        & frame["packet_rate"].ge(MIN_PACKET_RATE)
    ].copy()
    frame = frame.drop_duplicates(subset=["timestamp"], keep="last").sort_values("timestamp")
    retained = len(frame)
    if frame.empty:
        return frame, retained

    frame["capture"] = label_from_path(path)
    frame["elapsed_seconds"] = (frame["timestamp"] - frame["timestamp"].iloc[0]).dt.total_seconds()
    frame["bucket_seconds"] = (frame["elapsed_seconds"] // BUCKET_SECONDS * BUCKET_SECONDS).astype(int)
    return frame, retained


def aggregate_windows(frame: pd.DataFrame, baseline: float, tolerance: float) -> pd.DataFrame:
    """Represent each 10-second period by the median of its clean readings."""
    grouped = frame.groupby(["capture", "bucket_seconds"], as_index=False)
    clean = grouped[METRICS].median()
    counts = grouped.size().rename(columns={"size": "readings"})
    clean = clean.merge(counts, on=["capture", "bucket_seconds"], validate="one_to_one")
    clean["baseline_deviation"] = (clean["baseline_diff"] - baseline).abs()
    clean["algorithm_motion"] = clean["baseline_deviation"] > tolerance
    return clean


def calculate_calibration(captures: list[pd.DataFrame]) -> tuple[float, float]:
    """Use empty.csv as reference, even when plotting one other capture alone."""
    empty = next((frame for frame in captures if not frame.empty and frame["capture"].iat[0] == "Empty room"), None)
    if empty is None:
        reference_path = Path("data/empty.csv")
        if not reference_path.exists():
            raise ValueError("Include data/empty.csv so the plot can calculate the vacant-room reference.")
        empty, _ = load_and_clean(reference_path)
        if empty.empty:
            raise ValueError("data/empty.csv has no calibrated reliable readings for the vacant-room reference.")
    baseline = float(empty["baseline_diff"].median())
    tolerance = float((empty["baseline_diff"] - baseline).abs().quantile(0.95))
    return baseline, tolerance


def main() -> None:
    if len(sys.argv) < 3:
        raise SystemExit("Usage: plot_motion_comparison.py INPUT_CSV [INPUT_CSV ...] OUTPUT_PNG")

    *input_names, output_name = sys.argv[1:]
    input_paths = [Path(name) for name in input_names]
    output_path = Path(output_name)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    captures: list[pd.DataFrame] = []
    skipped: list[str] = []
    for path in input_paths:
        if path.name.endswith(".cleaned.csv"):
            skipped.append(f"{path.name}: generated cleaned file")
            continue
        try:
            frame, retained = load_and_clean(path)
            if frame.empty:
                skipped.append(f"{path.name}: no calibrated reliable readings")
            else:
                captures.append(frame)
                print(f"{path.name}: retained {retained} clean readings")
        except (OSError, ValueError, pd.errors.ParserError) as error:
            skipped.append(f"{path.name}: {error}")

    if not captures:
        raise SystemExit("No usable capture data. Check the input filenames and calibration state.")

    baseline, tolerance = calculate_calibration(captures)
    cleaned = pd.concat([aggregate_windows(frame, baseline, tolerance) for frame in captures], ignore_index=True)
    cleaned_path = output_path.with_suffix(".cleaned.csv")
    cleaned.to_csv(cleaned_path, index=False)

    labels = list(cleaned["capture"].drop_duplicates())
    colors = dict(zip(labels, sns.color_palette("tab10", n_colors=len(labels))))
    lower_threshold = baseline - tolerance
    upper_threshold = baseline + tolerance

    sns.set_theme(style="whitegrid", context="notebook")
    figure, axes = plt.subplots(2, 2, figsize=(16, 10), constrained_layout=True)

    axis = axes[0, 0]
    for label, subset in cleaned.groupby("capture", sort=False):
        axis.plot(subset["bucket_seconds"], subset["baseline_diff"], marker="o", markersize=3, linewidth=1.6, color=colors[label], label=label)
    axis.axhspan(lower_threshold, upper_threshold, color="#76B7B2", alpha=0.16, label="Vacant range")
    axis.axhline(baseline, color="#555555", linewidth=1.2, linestyle="--", label="Empty reference")
    axis.axhline(lower_threshold, color="#E45756", linewidth=1, linestyle=":")
    axis.axhline(upper_threshold, color="#E45756", linewidth=1, linestyle=":", label="Occupied threshold")
    axis.set(title="Baseline difference: cleaned 10-second medians", xlabel="Seconds since each capture started", ylabel="Baseline difference")
    axis.legend(loc="best", fontsize=8)

    axis = axes[0, 1]
    for label, subset in cleaned.groupby("capture", sort=False):
        axis.plot(subset["bucket_seconds"], subset["baseline_deviation"], marker="o", markersize=3, linewidth=1.6, color=colors[label], label=label)
    axis.axhline(tolerance, color="#E45756", linewidth=1.2, linestyle="--", label="Motion threshold")
    axis.set(title="Deviation from empty-room reference", xlabel="Seconds since each capture started", ylabel="Absolute deviation")
    axis.legend(loc="best", fontsize=8)

    axis = axes[1, 0]
    distribution = cleaned.melt(id_vars="capture", value_vars=["baseline_diff", "motion_score", "motion_max"], var_name="metric", value_name="value")
    sns.boxplot(data=distribution, x="metric", y="value", hue="capture", palette=colors, ax=axis)
    axis.set(title="Cleaned feature distributions", xlabel="", ylabel="Value")
    axis.legend(title="", fontsize=8)

    axis = axes[1, 1]
    for label, subset in cleaned.groupby("capture", sort=False):
        axis.plot(subset["bucket_seconds"], subset["packet_rate"], marker="o", markersize=3, linewidth=1.4, color=colors[label], label=label)
    axis.axhline(MIN_PACKET_RATE, color="#E45756", linewidth=1.2, linestyle="--", label="Minimum reliable rate")
    axis.set(title="Packet-rate quality after cleaning", xlabel="Seconds since each capture started", ylabel="Packets per second")
    axis.legend(loc="best", fontsize=8)

    figure.suptitle(f"Wi-Fi CSI comparison — empty reference {baseline:.4f}, tolerance ±{tolerance:.4f}", fontsize=15, fontweight="bold")
    figure.savefig(output_path, dpi=180, bbox_inches="tight")

    print(f"Saved plot: {output_path}")
    print(f"Saved cleaned data: {cleaned_path}")
    if skipped:
        print("Skipped:")
        for reason in skipped:
            print(f"  - {reason}")


if __name__ == "__main__":
    main()
