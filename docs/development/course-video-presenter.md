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
- `presenterSlides`：可选，只对这些 slide 索引生成片段（例如 `[0]`）；
- `presenterBackend`：`auto`（默认）| `talkinghead` | `command` | `minimax`；
  `auto` 的选择顺序是 **GPU 口型同步服务 → 口型同步命令 → 轻微人像运动（Ken Burns）**；
  `locmodel` 是旧名字，读到时按 `minimax` 处理；
- `presenterModel`：本地视频模型 id（例如 `unsloth/MiniMax-H3-GGUF`）；
- `presenterPrompt`：视频模型的动作描述，留空用内置提示词。

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

## SadTalker 接入（完整数字人）

Wav2Lip 只改变嘴部；需要头部姿态、眨眼和表情时使用 SadTalker。包装脚本需满足 `<portrait> <audio> <out>`：

```bash
OPENCREATOR_PRESENTER_CMD="/path/to/sadtalker_wrap.sh {portrait} {audio} {out}"
SADTALKER_DIR=/path/to/SadTalker
SADTALKER_PY=/path/to/sadtalker-venv/bin/python
SADTALKER_SIZE=256
SADTALKER_PREPROCESS=crop
```

- `SADTALKER_SIZE=256` 适合画中画；`512` 质量更高但明显更慢。
- SadTalker 在 ROCm 上约每 30 秒音频需要数分钟，长 slide 会更久；可用 `presenterSlides` 限制范围。
- 生成的数字人片段自带音频，但 `CourseLesson` 组合会对 `OffthreadVideo` 设置 `muted`，最终视频只保留旁白音轨。

## MiniMax-H3 人像动画（无口型）

`presenterBackend=minimax`（旧值 `locmodel` 视为同一个）用本机 **Unsloth Studio** 的
视频模型（默认 `unsloth/MiniMax-H3-GGUF`）把肖像做成动态画面：头部动作、眨眼、手势。

- 走 Unsloth 的 OpenAI 视频接口：`POST /v1/videos`（带 `input_reference` 传肖像）→
  轮询 `GET /v1/videos/{id}` → 从 `/v1/videos/{id}/content` 下载 mp4。
  设置里的「视频生成 → 本地 Unsloth」地址/模型/Key 就是这里用的配置。
- **不做口型同步**：视频接口不接受音频，嘴型不会跟旁白对齐。旁白仍用课程自己的音轨，
  组合时数字人片段是静音的。需要真口型请选 `talkinghead`（SadTalker）。
- 画幅会被映射成 MiniMax-H3 的预设（横屏 `864x480`，竖屏 `480x864`，方形 `768x768`）；
  单条最多 10 秒，短于 slide 的片段用 ffmpeg `-stream_loop` 循环到整条 slide。
- 生成前必须已加载视频模型，或在 Unsloth 设置 → API 打开 **Model auto-switch**，
  否则接口返回 `No video model loaded`（503），preflight 也会给出警告。
- MiniMax-H3 是 21 GB 的 Q8 模型，iGPU 显存紧张：如果报 out of memory，在 Unsloth 视频页把
  **Memory mode** 设为 **Low VRAM**，或换更小的量化。渲染期间不要同时跑 SadTalker 分片或
  ComfyUI，否则会互相抢显存。
- 因为不快、也不口型同步，`auto` **不会**自动选它，必须显式选择。

### 没有 GPU 后端时的人像运动（Ken Burns）

`auto` 在既没有口型同步命令、口型同步服务也不可达时，会用 ffmpeg 给肖像加一个很慢的推近 + 轻微平移
（每个 slide 一条，CPU 上约 1 秒），并写入 `course-avatar` 的片段，`presenterBackend` 记为 `motion`。
它只是让画面不是静止的，**不做口型同步**。preflight 会对这种情况给出警告标题
“Presenter will only have portrait motion”。

## 口型同步引擎（Windows GPU）

数字人服务 `D:\ai\avatar\server.py` 现在内置多个引擎，任务里用 `engine` 字段选择
（不填则用服务的 `AVATAR_ENGINE`，默认 `sadtalker`）：

| `engine` | bb_creator 引擎 | 实测速度（5 s 旁白） | 特点 |
| --- | --- | --- | --- |
| `sadtalker` | `talkinghead` | 约 1.5–2.5 分钟（10 s 片段约 4 分钟） | 头部运动 + 眨眼 + 口型，长片段自动分片 |
| `wav2lip` | `wav2lip` | 5 s 片段实测 10 s（冷启动约 20 s） | 只重绘嘴部，最快，适合整门课 |
| `latentsync` | 暂不开放 | 256² 约 9 分钟 / 3 秒；512² 24 分钟未完成 | 本机实测输出损坏或过慢，暂不作为选项 |
| `musetalk` | 未开放 | 约 6 分钟 | 在这块 ROCm iGPU 上嘴部输出噪点，暂不可用 |

结论：本机可用的口型引擎是 **SadTalker**（默认，头部运动）和 **Wav2Lip**（最快，只动嘴）。
LatentSync 和 MuseTalk 的权重都已装好，但这块 ROCm iGPU 上的扩散/UNet 输出不可用。

`GET /health` 会返回 `engines` 列表，preflight 用它判断所选引擎是否已安装。

Wav2Lip 需要 `wav2lip_gan.pth` + s3fd，装在 `D:\ai\avatar\repos\Wav2Lip`
（`bin\wav2lip_infer_cpuface.py` 强制人脸检测走 CPU，避免 gfx1151 的 MIOpen 首次卷积变慢）。
LatentSync 用 `D:\ai\avatar\repos\LatentSync` 和 `venvs\latentsync`（继承系统 ROCm torch），
模型来自 WSL 里已有的 checkpoint 副本。

## Windows GPU 数字人服务（SadTalker）

WSL 没有 GPU，而课程视频的 daemon 跑在 WSL。GPU 数字人因此放在 Windows，
通过本机 HTTP 服务调用（避免用 WSL interop 直接跑 GPU 进程——那会在 HIP 里崩溃）：

```bash
OPENCREATOR_TALKING_HEAD_URL=http://127.0.0.1:8691
```

服务端：`D:\ai\avatar\server.py`，`AVATAR_ENGINE=sadtalker`，
venv `D:\ai\avatar\venvs\sadtalker`（复用系统 Python312 的 ROCm torch），
由计划任务 **Avatar service (SadTalker)** 在登录时启动，或手动
`D:\ai\avatar\bin\start-avatar-service.cmd`。

接口（**异步任务**，渲染要几分钟，不能一直占着 HTTP 连接，否则会触发
undici 的 5 分钟 `UND_ERR_HEADERS_TIMEOUT`）：

- `GET /health` → `{"ok":true,"busy":false,"engine":"sadtalker","active":0,"concurrency":2}`
- `POST /v1/avatar` `{portrait_b64, audio_b64, duration, fps}` → `202 {id, status}`
- `GET /v1/avatar/{id}` → `{status: queued|running|done|failed, error?}`
- `GET /v1/avatar/{id}/content` → `video/mp4`（完成后）
- `DELETE /v1/avatar/{id}` → 清理

`auto` 的顺序是 **GPU 数字人 → `OPENCREATOR_PRESENTER_CMD`（CPU SadTalker）→ Ken Burns 人像运动**；
显式选择 `talkinghead` 时如果服务不可达，preflight 会直接拦下并提示启动服务。

### 进度显示

`presenter` 阶段会持续上报进度，界面不会只停在 0%：

- 每个片段开始时显示「正在生成数字人片段（已完成/总数）」，并显示已运行时间；
- MiniMax-H3 的 `%` 直接来自 Unsloth 的 `progress`，会按片段数折算成整体百分比；
- SadTalker / Wav2Lip 的任务接口没有百分比，daemon 每 30 秒发一次心跳
  （`Talking head clip running (elapsed 3:20)`），避免界面看起来卡住；
- 视频生成工具同样显示百分比和已运行时间；MiniMax 前几分钟停在 0% 时会说明
  「本机约每 2–3 分钟前进 5%」。

### 长镜头分片

一段旁白超过 12 秒时，daemon 会把它切成 **10 秒一片**，同时最多送 **2 片**
（服务端 `AVATAR_CONCURRENCY=2`，每个任务独立加载模型），渲染完再用 ffmpeg
`concat` 拼回一条，并裁到旁白时长。好处是墙钟时间约减半，且重试只需要重渲染失败的分片。
末尾不足 3 秒的余量会并入上一片（例如 42.84 秒 → 10/10/10/12.84），
因为 SadTalker 的 `savgol_filter` 在帧数太少时会直接报错
（`polyorder must be less than window_length`）；服务端也会把过短的音频补静音到 2 秒。

- 服务端忙时会立即返回 `429`（不占住连接），daemon 每 20 秒重试，最多等 40 分钟；
  课程重试或 daemon 重启撞上正在渲染的片段时会排队继续，而不是直接失败。
- 单个片段失败（ROCm 偶发崩溃、服务 5xx）会自动重跑一次；超时和 404 不重试。
- 短于 12 秒的镜头仍然一次渲染，不做分片。
- 分片时同一时间占用 2 个 GPU 任务；这段时间不要再让 Unsloth / ComfyUI 出片，
  否则会和数字人抢显存，两边都变慢。

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
