# Studio（媒体工坊）

Studio 是 bb_creator 内置的媒体能力页面（`/#/studio`），由 Daemon 的 `apps/daemon/src/studio/` 原生实现，
**不依赖 OpenMontage 或任何外部项目代码**。它取代了 bb_video 中的 OpenMontage 面板。

## 能力

| 分组 | 能力 id | 运行方式 | 依赖 |
| --- | --- | --- | --- |
| Make something new | `cinematic` `one-take` `commercials` `broll` | Wan 2.2 14B 文生视频（4 步 LightX2V，双专家采样） | ComfyUI + Wan 模型文件 |
| | `products` | Wan 2.2 图生视频（需上传图片） | 同上 |
| | `minimax` `minimax-i2v` | MiniMax-H3，经现有 `video-generation` 服务（`local-sd`/Unsloth） | Unsloth Studio 已加载 H3 |
| | `presenter` `explainer` | ComfyUI SD1.5 出图 + Piper 旁白 + ffmpeg 合成（无口型） | ComfyUI、Piper、ffmpeg |
| | `3d-worlds` | 由提示词确定性生成 Three.js 世界，HyperFrames 逐帧渲染 | Node（npx）、Chrome |
| | `motion` | 动态字幕 HTML，HyperFrames 渲染 | 同上 |
| | `documentary` | 从 Archive.org / NASA / Wikimedia（免 key）取素材，ffmpeg 交叉淡化剪辑 | 网络、ffmpeg |
| Courses | `course` | 跳转到 Course Video 模板 | — |
| Edit and repurpose | `tighten` `vertical` | 精确裁剪、横转竖/方/宽银幕（可设水平焦点） | ffmpeg |
| | `captions` | faster-whisper 词级时间轴 → SRT → 烧录 | ffmpeg、faster-whisper |
| Change the look | `grade` | 7 种预设调色，可按强度混合 | ffmpeg |
| Sound and music | `narrate` | Piper 离线 TTS，输出 WAV | Piper + 语音 |
| Fix what you shot | `upscale` | Lanczos 放大 2x/4x + 轻度锐化 | ffmpeg |

能力目录、可用性检查和任务队列都在 Runtime 里；前端只渲染 `GET /studio/capabilities` 返回的内容。
不可用的能力会带 `reason`（例如“GPU worker offline”）。

## 目录与配置

数据都在 `<dataDir>/studio`（默认 `~/.opencreator/data/studio`）：

- `venv/` — Piper 与 faster-whisper 的 Python 环境
- `voices/` — Piper 语音（`*.onnx` + `*.onnx.json`）
- `jobs/<id>/` — 每个任务的 `job.json`、中间文件和 `output.mp4|wav`
- `uploads/` — 上传的图片/视频（7 天后清理）

首次使用运行一次（幂等）：

```bash
pnpm studio:setup                       # 创建 venv、安装依赖、下载默认 4 个语音
pnpm studio:setup --voices en_US-lessac-medium   # 只下载指定语音
```

环境变量（均可选）：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `OPENCREATOR_STUDIO_HOME` | `<dataDir>/studio` | Studio 根目录 |
| `OPENCREATOR_STUDIO_VOICES` | `<home>/voices` | Piper 语音目录 |
| `OPENCREATOR_STUDIO_PYTHON` / `_PIPER` | `<home>/venv/bin/...` | 覆盖解释器 / piper 可执行文件 |
| `COMFYUI_URL` | `http://127.0.0.1:8188` | ComfyUI 地址（与 Course Video 共用） |
| `OPENCREATOR_STUDIO_HYPERFRAMES` | `npx --yes hyperframes` | HyperFrames 命令 |
| `OPENCREATOR_STUDIO_WINDOWS_RENDER_ROOT` | 未设置 | 设置后在 Windows 侧渲染 HyperFrames，Chrome 使用真实 GPU（实测 4 秒 3D 片段 15 秒 vs WSL 软件渲染 71 秒） |
| `OPENCREATOR_STUDIO_WINDOWS_FFMPEG_BIN` | 未设置 | Windows 侧 ffmpeg 的 `bin` 目录（Windows 渲染必需） |
| `OPENCREATOR_STUDIO_COMFY_TASK` / `_AVATAR_TASK` / `_COMFY_STOP` | `ComfyUI (manual)` / `Avatar service (SadTalker)` / `C:\ComfyUI\stop-comfyui.cmd` | GPU worker 启停所用的计划任务与脚本 |
| `OPENCREATOR_STUDIO_LLM_URL` | `http://127.0.0.1:8888` | 仅用于 GPU worker 状态探测 |

GPU worker 的启停按钮仅在主机能调用 `powershell.exe`（WSL）时显示（`canControl`）。

## API

全部走 Runtime 鉴权：`GET /studio/capabilities[?refresh=1]`、`GET /studio/worker`、
`POST /studio/worker/{start,stop}`、`POST /studio/uploads?fileName=`（Content-Type
`application/vnd.opencreator.studio-upload`，流式）、`GET|POST /studio/jobs`、
`GET|DELETE /studio/jobs/:id`、`POST /studio/jobs/:id/cancel`、`GET /studio/jobs/:id/media`（支持 Range）。

任务分两条队列：重任务（GPU/渲染/转写）同时 1 个，轻任务（ffmpeg）同时 2 个。取消会终止整个子进程树，
Wan 任务还会向 ComfyUI 发送 `/queue` 删除与 `/interrupt`。Runtime 重启时仍在运行的任务会标记为失败。

## 验证

```bash
pnpm --filter @opencreator/daemon exec vitest run test/unit/studio-pure.test.ts test/unit/studio-service.test.ts
pnpm --filter @opencreator/web exec vitest run src/features/studio src/services/studio-service.test.ts
```
