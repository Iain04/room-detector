"""Create a Seaborn comparison of empty-room and activity MQTT captures."""

from pathlib import Path
import sys
import os

os.environ.setdefault("MPLCONFIGDIR", str(Path.cwd() / ".matplotlib-cache"))
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import pandas as pd
import seaborn as sns


METRICS = [
    ("motion_score", "Motion score"),
    ("motion_excess", "Motion excess"),
    ("motion_max", "Motion max"),
    ("baseline_diff", "Baseline difference"),
]
PALETTE = {"Empty room": "#4C78A8", "Activity": "#F58518"}


def load_capture(path: Path, label: str) -> pd.DataFrame:
    frame = pd.read_csv(path)
    frame["capture"] = label
    frame["timestamp"] = pd.to_datetime(frame["timestamp"], errors="coerce", utc=True)
    if frame["timestamp"].notna().any():
        frame["elapsed_seconds"] = (frame["timestamp"] - frame["timestamp"].min()).dt.total_seconds()
    else:
        frame["elapsed_seconds"] = frame.index
    for metric, _ in METRICS + [("packet_rate", "Packet rate")]:
        frame[metric] = pd.to_numeric(frame[metric], errors="coerce")
    return frame


def main() -> None:
    if len(sys.argv) != 4:
        raise SystemExit("Usage: plot_motion_comparison.py EMPTY_CSV ACTIVITY_CSV OUTPUT_PNG")

    empty_path, activity_path, output_path = map(Path, sys.argv[1:])
    empty = load_capture(empty_path, "Empty room")
    activity = load_capture(activity_path, "Activity")
    output_path.parent.mkdir(parents=True, exist_ok=True)

    sns.set_theme(style="whitegrid", context="notebook")
    figure, axes = plt.subplots(3, 2, figsize=(15, 14), constrained_layout=True)
    captures = [empty, activity]

    for axis, (metric, label) in zip(axes.flat[:4], METRICS):
        for capture in captures:
            axis.plot(
                capture["elapsed_seconds"], capture[metric],
                label=capture["capture"].iat[0], color=PALETTE[capture["capture"].iat[0]], alpha=0.78, linewidth=1.2,
            )
        axis.set_title(f"{label} over time")
        axis.set_xlabel("Seconds since capture start")
        axis.set_ylabel(label)
        axis.legend()

    distribution = pd.concat([empty, activity], ignore_index=True).melt(
        id_vars="capture", value_vars=["motion_score", "motion_excess", "motion_max", "baseline_diff"],
        var_name="metric", value_name="value",
    ).dropna()
    sns.boxplot(data=distribution, x="metric", y="value", hue="capture", palette=PALETTE, ax=axes[2, 0])
    axes[2, 0].set_title("Metric distributions")
    axes[2, 0].set_xlabel("")
    axes[2, 0].set_ylabel("Value")
    axes[2, 0].tick_params(axis="x", rotation=20)
    axes[2, 0].legend(title="Capture")

    for capture in captures:
        axis = axes[2, 1]
        axis.plot(
            capture["elapsed_seconds"], capture["packet_rate"],
            label=capture["capture"].iat[0], color=PALETTE[capture["capture"].iat[0]], alpha=0.78, linewidth=1.2,
        )
    axes[2, 1].axhline(50, color="#E45756", linestyle="--", linewidth=1, label="Reliability minimum")
    axes[2, 1].set_title("Packet-rate quality")
    axes[2, 1].set_xlabel("Seconds since capture start")
    axes[2, 1].set_ylabel("Packets per second")
    axes[2, 1].legend()

    figure.suptitle("Wi-Fi CSI motion comparison: empty room vs activity", fontsize=16, fontweight="bold")
    figure.savefig(output_path, dpi=180, bbox_inches="tight")
    print(f"Saved {output_path}")


if __name__ == "__main__":
    main()
