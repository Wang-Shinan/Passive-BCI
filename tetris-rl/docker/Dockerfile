# Tetris RL — Tione training image
# Actual jobs use this tag as a platform PreSet image (no private TCR push).
# Rebuild only if you must bake gymnasium into a custom TCR repo.
FROM tione.tencentcloudcr.com/qcloud-ti-platform/notebook-conda-gpu:verl0.6.1-vllm0.11.0-torch2.8-py312-cuda12.8-gpu

WORKDIR /workspace/tetris-rl
COPY pyproject.toml ./
RUN python3 -m pip install --no-cache-dir gymnasium>=0.29 numpy>=1.24 onnx>=1.15 onnxscript>=0.1.0 \
    && python3 -c "import torch; assert torch.cuda.is_available() or True"

COPY tetris_rl ./tetris_rl
ENV PYTHONPATH="/workspace/tetris-rl:${PYTHONPATH}"
ENV PYTHONUNBUFFERED=1
ENV OMP_NUM_THREADS=1
ENV MKL_NUM_THREADS=1
CMD ["python3", "-m", "tetris_rl", "train", "--config", "configs/bc_h20.json"]
