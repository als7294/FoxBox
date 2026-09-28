"""HT-Demucs on MLX, vendored (only what inference needs) so the stem splitter adds no runtime dependency.

From demucs-mlx 1.4.14 (the MLX port of Meta's Demucs) and mlx-spectro 0.9.7 (its STFT), both MIT: see LICENSE and
_spectro/LICENSE. Changes: imports made package-relative; apply_model without model bags or the `packaging` check;
mlx-spectro's autotune cache stays in memory (it would otherwise write to ~/.cache).
"""
