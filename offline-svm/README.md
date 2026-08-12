# Offline SVM + 置信度回归

被试外验证特征 SVM / SVR。代码放 COS，**在集群/挂载机上跑**，不要在笔记本拉全量数据。

## COS 位置

```
cos:omni-eeg-1442740494/omni-eeg-01/wsn/passive-bci-offline-svm/
```

上传（本机）：

```bash
# from repo root
rclone sync offline-svm/ cos:omni-eeg-1442740494/omni-eeg-01/wsn/passive-bci-offline-svm/ \
  --exclude '.venv/**' --exclude 'data/**' --exclude 'results/**' \
  --exclude '__pycache__/**' --exclude '.DS_Store' --progress
```

结果回写：

```
.../wsn/passive-bci-offline-svm/results/
```

## 数据集

| key | 维度 | COS | 前端映射 |
|-----|------|-----|----------|
| workload | easy/med/diff 负荷 | ✅ preprocess zarr | cognitive_load / stress |
| eegmat | 心算二分类 | ✅ zarr | cognitive_load |
| deap | V/A/D/Liking | ✅ ratings + zarr；完整 .dat 另解压 | arousal / relaxation / satisfaction |
| stew | rest vs SIMKAP | ❌ 需自备 → `data/stew/stew_windows.npz` | cognitive_load |

路径详见 `configs/remote_paths.yaml`。

## 集群上跑

假设数据已挂载到 `/mnt/omni-eeg-01`：

```bash
rclone copy cos:omni-eeg-1442740494/omni-eeg-01/wsn/passive-bci-offline-svm/ . \
  --exclude 'results/**' --progress
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
chmod +x scripts/run_on_cluster.sh

./scripts/run_on_cluster.sh list
./scripts/run_on_cluster.sh workload --max-samples 5000
./scripts/run_on_cluster.sh eegmat
./scripts/run_on_cluster.sh deap --deap-target arousal
./scripts/run_on_cluster.sh all

# 把结果推回 COS
rclone sync results/ cos:omni-eeg-1442740494/omni-eeg-01/wsn/passive-bci-offline-svm/results/ --progress
```

`run_on_cluster.sh` 会把 mount 下的 zarr **软链**到 `data/<ds>/`，无需再拷贝。

## 特征

与浏览器 `src/lib/features/bandFeatures.ts` 对齐：相对频带 + neuroskill scores + RMS。

## 输出契约（上线）

```json
{ "value": 0-100, "confidence": 0-1, "label": "...", "qc": "ok|low_conf" }
```

低置信度 → 前端回退 manual。
