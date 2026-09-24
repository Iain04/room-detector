"""Clean and compare empty-room and activity Wi-Fi CSI captures.

Usage:
    python scripts/plot_motion_comparison.py data/empty.csv data/busy.csv data/comparison.png
"""

from pathlib import Path
import os
import sys

os.environ.setdefault("MPLCONFIGDIR", str(Path.cwd() / ".matplotlib-cache"))
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import pandas as pd
import seaborn as sns


METRICS = {
    "motion_score": "Motion score",
    "motion_excess": "Motion excess",
    "motion_max": "Motion max",
    "baseline_diff": "Baseline difference",
    "rssi": "RSSI (dBm)",
    "packet_rate": "Packets per second",
}
PALETTE = {"Empty room": "#4C78A8", "Activity": "#F58518"}
BUCKET_SECONDS = 10
MIN_PACKET_RATE = 50
EMPTY_BASELINE_MEDIAN = 0.4115
EMPTY_BASELINE_TOLERANCE = 0.0515


def as_boolean(series: pd.Series) -> pd.Series:
    return series.astype(str).str.strip().str.lower().isin(["true", "1", "yes"])


def load_and_clean(path: Path, label: str) -> pd.DataFrame:
    raw = pd.read_csv(path)
    required = {"timestamp", "baseline_diff", "packet_rate", "calibrated", "reliable"}
    missing = required.difference(raw.columns)
    if missing:
        raise ValueError(f"{path} is missing required columns: {', '.join(sorted(missing))}")

    frame = raw.copy()
    frame["timestamp"] = pd.to_datetime(frame["timestamp"], errors="coerce", utc=True)
    for metric in METRICS:
        frame[metric] = pd.to_numeric(frame[metric], errors="coerce")
    frame["calibrated"] = as_boolean(frame["calibrated"])
    frame["reliable"] = as_boolean(frame["reliable"])

    # Keep decision-quality readings. Signal values are not clipped: true movement
    # spikes are useful evidence and must remain in the analysis.
    frame = frame.loc[
        frame["timestamp"].notna()
        & frame["baseline_diff"].notna()
        & frame["calibrated"]
        & frame["reliable"]
        & frame["packet_rate"].ge(MIN_PACKET_RATE)
    ].copy()
    frame = frame.drop_duplicates(subset=["timestamp"], keep="last").sort_values("timestamp")
    if frame.empty:
        raise ValueError(f"{path} has no calibrated, reliable readings after cleaning")

    frame["capture"] = label
    frame["elapsed_seconds"] = (frame["timestamp"] - frame["timestamp"].iloc[0]).dt.total_seconds()
    frame["bucket_seconds"] = (frame["elapsed_seconds"] // BUCKET_SECONDS * BUCKET_SECONDS).astype(int)
    return frame


def aggregate_10_seconds(frame: pd.DataFrame) -> pd.DataFrame:
    grouped = frame.groupby(["capture", "bucket_seconds"], as_index=False)
    clean = grouped[list(METRICS)].median()
    counts = grouped.size().rename(columns={"size": "readings"})
    clean = clean.merge(counts, on=["capture", "bucket_seconds"], validate="one_to_one")
    clean["baseline_deviation"] = (clean["baseline_diff"] - EMPTY_BASELINE_MEDIAN).abs()
    clean["algorithm_motion"] = clean["baseline_deviation"] > EMPTY_BASELINE_TOLERANCE
    return clean


def main() -> None:
    if len(sys.argv) != 4:
        raise SystemExit("Usage: plot_motion_comparison.py EMPTY_CSV ACTIVITY_CSV OUTPUT_PNG")

    empty_path, activity_path, output_path = map(Path, sys.argv[1:])
    output_path.parent.mkdir(parents=True, exist_ok=True)
    raw_empty = load_and_clean(empty_path, "Empty room")
    raw_activity = load_and_clean(activity_path, "Activity")
    clean = pd.concat([aggregate_10_seconds(raw_empty), aggregate_10_seconds(raw_activity)], ignore_index=True)
    clean_path = output_path.with_suffix(".cleaned.csv")
    clean.to_csv(clean_path, index=False)

    sns.set_theme(style="whitegrid", context="notebook")
    figure, axes = plt.subplots(2, 2, figsize=(15, 10), constrained_layout=True)

    # The selected classifier signal. 10-second medians reduce noise while
    # preserving the temporal separation between empty and active captures.
    axis = axes[0, 0]
    for label, subset in clean.groupby("capture", sort=False):
        axis.plot(subset["bucket_seconds"], subset["baseline_diff"], marker="o", markersize=3,
                  linewidth=1.8, color=PALETTE[label], label=label)
    axis.axhline(EMPTY_BASELINE_MEDIAN, color="#555555", linewidth=1.2, label="Empty reference")
    axis.axhspan(EMPTY_BASELINE_MEDIAN - EMPTY_BASELINE_TOLERANCE,
                 EMPTY_BASELINE_MEDIAN + EMPTY_BASELINE_TOLERANCE,
                 color="#4C78A8", alpha=0.12, label="No-motion band")
    axis.set(title="Baseline difference: cleaned 10-second medians", xlabel="Seconds since each capture started", ylabel="Baseline difference")
    axis.legend(loc="best")

    axis = axes[0, 1]
    for label, subset in clean.groupby("capture", sort=False):
        axis.plot(subset["bucket_seconds"], subset["baseline_deviation"], marker="o", markersize=3,
                  linewidth=1.8, color=PALETTE[label], label=label)
    axis.axhline(EMPTY_BASELINE_TOLERANCE, color="#E45756", linestyle="--", label="Motion threshold")
    axis.set(title="Classifier deviation from empty-room reference", xlabel="Seconds since each capture started", ylabel="Absolute deviation")
    axis.legend(loc="best")

    axis = axes[1, 0]
    distribution = clean.melt(id_vars="capture", value_vars=["baseline_diff", "motion_score", "motion_max"],
                              var_name="metric", value_name="value")
    sns.boxplot(data=distribution, x="metric", y="value", hue="capture", palette=PALETTE, ax=axis)
    axis.set(title="Cleaned feature distributions", xlabel="", ylabel="Value")
    axis.legend(title="")

    axis = axes[1, 1]
    for label, subset in clean.groupby("capture", sort=False):
        axis.plot(subset["bucket_seconds"], subset["packet_rate"], marker="o", markersize=3,
                  linewidth=1.5, color=PALETTE[label], label=label)
    axis.axhline(MIN_PACKET_RATE, color="#E45756", linestyle="--", label="Minimum reliable rate")
    axis.set(title="Packet-rate quality after cleaning", xlabel="Seconds since each capture started", ylabel="Packets per second")
    axis.legend(loc="best")

    figure.suptitle("Wi-Fi CSI comparison: empty room vs activity", fontsize=16, fontweight="bold")
    figure.savefig(output_path, dpi=180, bbox_inches="tight")

    print(f"Raw readings retained: empty={len(raw_empty)}, activity={len(raw_activity)}")
    print(f"10-second windows: empty={(clean['capture'] == 'Empty room').sum()}, activity={(clean['capture'] == 'Activity').sum()}")
    print(f"Saved cleaned data: {clean_path}")
    print(f"Saved plot: {output_path}")


if __name__ == "__main__":
    main()
