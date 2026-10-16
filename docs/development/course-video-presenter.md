# 课程视频数字人（Presenter）

课程视频流水线在旁白之后、渲染之前有一个 `presenter` 阶段：为每个 slide 生成口型同步的数字人片段，并合并进渲染。它让课程视频里的讲师“开口说话”，而不是只有静态头像。

## 渲染展示优先级

组合 `CourseLessonLandscape` 右下角画中画（PiP）按以下优先级展示：

1. `slide.avatarSrc` —— 口型同步的数字人视频；
2. `presenter.portraitSrc` —— 课程品牌静态人像（`bb_exam` branding 的 `presenterUrl` / `instructorAvatarUrl`）；
3. 生成式占位卡 —— 姓名缩写 + 姓名 + 角色。

因此即使没有数字人后端，视频也始终有讲师画面。

## 数据流

- `narration` → `course-narrated-lesson`（每个 slide 含 `audioSrc` / `captions` / `durationInFrames`）。
- `presenter` → `course-avatar`：`{ portraitPath, clips: [{ slideId, path }] }`。
- `render` 输入 `course-narrated-lesson` + 可选 `course-avatar`，通过 `applyAvatarClips` 把片段合并为 `slide.avatarSrc`；worker 通过本地资源服务器提供这些片段。

阶段图：`import → plan → narration → presenter → render → deliver`。

## 配置

环境变量（启动 Daemon 时设置）：

| 变量 | 说明 |
| --- | --- |
| `OPENCREATOR_PRESENTER_CMD` | 命令模板，占位符 `{portrait}` `{audio}` `{out}`；未设置则跳过数字人生成 |
| `OPENCREATOR_PRESENTER_PORTRAIT` | 默认讲师人像（栅格图 png/jpg） |
| `OPENCREATOR_PRESENTER_CWD` | 可选命令工作目录 |

按任务（job state）：

- `portraitPath`：覆盖默认人像；
- `presenterSlides`：可选，只对这些 slide 索引生成片段（例如 `[0]`）。

未配置 `OPENCREATOR_PRESENTER_CMD` 或人像时，`presenter` 输出空清单，渲染回退到静态人像。

## Wav2Lip 接入（本机可用的示例）

1. 克隆 Wav2Lip 并放置 checkpoint `checkpoints/wav2lip_gan.pth`。
2. 准备包含 `torch`、`librosa`、`opencv` 等的 python 环境。
3. 使用仓库脚本 [`scripts/presenter/wav2lip_presenter.sh`](../../scripts/presenter/wav2lip_presenter.sh)，通过 `WAV2LIP_DIR` / `WAV2LIP_PY` / `WAV2LIP_CKPT` 指定路径。
4. 启动 Daemon：

```bash
OPENCREATOR_PRESENTER_CMD="/path/to/scripts/presenter/wav2lip_presenter.sh {portrait} {audio} {out}" \
OPENCREATOR_PRESENTER_PORTRAIT=/path/to/instructor.png \
pnpm daemon:dev
```

## 其他后端

命令接口与后端无关。SadTalker、MuseTalk、LatentSync、InfiniteTalk 等只要满足 `<portrait> <audio> <out>` 语义即可，用包装脚本适配后设置 `OPENCREATOR_PRESENTER_CMD`。

## 性能

### 数字人（presenter）

- 本机 Wav2Lip（ROCm GPU 生成 + **CPU 人脸检测**）约 **0.17 秒/秒音频**（约 6 倍实时）。模块 1 约 294 秒音频，8 路并发全量生成约 **23 秒**。
- 关键：人脸检测必须跑在 CPU。s3fd 检测器在 ROCm GPU 上运行会让**首次** Wav2Lip 卷积从 ~0.3 秒恶化到 ~150 秒（MIOpen kernel DB 未命中，且每次运行都会重演）。`wav2lip_presenter.sh` 默认通过 [`scripts/presenter/wav2lip_infer_cpuface.py`](../../scripts/presenter/wav2lip_infer_cpuface.py) 强制 CPU 人脸检测；如需关闭可设置 `WAV2LIP_INFER=$WAV2LIP_DIR/inference.py`。
- 片段默认并行生成，并发数由 `OPENCREATOR_PRESENTER_CONCURRENCY` 控制（默认按 CPU 推导、上限 8）。
- 每个片段的线程池默认限制为 4（`wav2lip_presenter.sh` 里的 `OMP_NUM_THREADS` / `OPENBLAS_NUM_THREADS` / `MKL_NUM_THREADS`，均可用同名环境变量覆盖）。不限制时 torch 会按核数开线程，8 路并发严重超订、比串行还慢；限制后 8 路约为串行的 1.7×，总 CPU 时间约减半。
- `wav2lip_presenter.sh` 每次调用使用独立临时工作目录：Wav2Lip 的 `inference.py` 使用固定的 `temp/result.avi`、`temp/temp.wav` 相对路径，共享目录会让并发片段互相覆盖。
- 注意：FP16 在本机 ROCm 上反而更慢（MIOpen fp16 卷积），不要开启。

### 渲染（render）

- Remotion 并发渲染帧数由 `OPENCREATOR_COURSE_RENDER_CONCURRENCY` 控制（默认按 CPU 推导、上限 8）。此前固定为 1，几乎所有核心空闲；提升后模块 1 从约 13 分钟降到约 3.5 分钟（gfx1151 / 32 核实测 4 路 3.3×、8 路 3.7×）。
- 实测单帧成本约 20ms（1080p 合成），与并发无关；数字人 PiP 只占约 12%，瓶颈在合成本身。

### 整体

- 模块 1 全流程（import → plan → narration → presenter → render）约 **4 分钟**：渲染约 3.5 分钟、数字人约 23 秒、旁白约 8 秒。
- 建议：用 `presenterSlides` 限制数字人片段范围；渲染并发可按内存调整（每路标签页约数百 MB）。

## 验证

对渲染结果抽取帧，比较 PiP 区域（右下 `360x240`，即 `crop=360:240:1488:768`）相邻帧的差异：

- 口型同步片段：相邻帧差异明显（本机实测约 0.9–1.0）；
- 静态人像：相邻帧差异接近 0。
