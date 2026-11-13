# 本地 AI 模型接入（Unsloth Studio）

OpenCreator 的文本、图片和视频任务都可以直接使用本机 **Unsloth Studio** 的
OpenAI 兼容接口。LocModel 已于 2026-11-13 卸载，所有本地生成改走 Unsloth。

Unsloth Studio 在 `127.0.0.1:8888` 提供：

| 能力 | 接口 | 说明 |
| --- | --- | --- |
| 文本 | `POST /v1/chat/completions`、`/v1/messages`、`/v1/embeddings` | 需要加载一个 LLM（或在设置 → API 开启 Model auto-switch） |
| 图片 | `POST /v1/images/generations` | OpenAI 兼容，`response_format: b64_json` 可直接取回图片 |
| 视频 | `POST /v1/videos` + `GET /v1/videos/{id}` + `GET /v1/videos/{id}/content` | OpenAI 视频任务，需要加载视频模型 |
| 模型列表 | `GET /v1/models` | 每个模型带 `loaded`、`quant`、`display_name` |

API Key 在 Unsloth Studio 的 **设置 → API** 里创建，与其他本机客户端共用
（Windows 用户环境变量 `STRATA_API_KEY` 里存的是同一个值）。

## 在 OpenCreator 中配置

### 文本模型

1. 设置 → AI 服务 → 模型服务 → 自定义模型服务 → 供应商：**Unsloth Studio (local)**。
2. Base URL：`http://127.0.0.1:8888/v1`。
3. 填入 API Key，点击 **检测模型**（读取 `GET /v1/models`），选择例如
   `unsloth/Muse-Glimmer-30B-GGUF`。
4. 保存。

### 图片

1. 先在 Unsloth Studio 里加载图片模型（例如 `unsloth/Qwen-Image-2.1-Turbo-GGUF`），
   或在设置 → API 打开 **Model auto-switch**。
2. 设置 → AI 服务 → 图像生成 → 服务商：**Unsloth Studio (local)**。
3. Base URL：`http://127.0.0.1:8888/v1`，模型填上一步的 id，填 API Key。
4. 保存后即可在「图像生成」里出图。

### 视频

1. 先在 Unsloth Studio 里加载视频模型（例如 `unsloth/MiniMax-H3-GGUF`）。
2. 设置 → AI 服务 → 视频生成 → 服务商：**Unsloth Studio (local)**，同样填 Base URL、模型、Key。
3. 保存。视频任务会 POST `/v1/videos`，轮询状态，然后从 `/v1/videos/{id}/content` 下载 mp4。

注意：

- Unsloth 的视频模型有训练分辨率，不接受任意尺寸。OpenCreator 会把三种画幅映射成
  MiniMax-H3 的预设：横屏 `864x480`、竖屏 `480x864`、方形 `768x768`（864x480 是
  本机 Vulkan 显存能稳定跑的最小档）。
- MiniMax-H3 是 14B / 21 GB 的 Q8 模型；如果 Vulkan 报 out of memory，在 Unsloth 的
  视频页把 **Memory mode** 设为 **Low VRAM**，或换更小的量化；再不行就用 ComfyUI 的
  Wan 2.2（视频页/OpenMontage 面板）出片。
- 单次生成只支持 4/5/6/8/10 秒（OpenAI `seconds` 字段）；更长的镜头请分段或换 Wan/ComfyUI。
- 生成前必须**已加载对应模型**，否则接口返回 `No model loaded`（503）。

## WSL / 容器

OpenCreator Runtime 跑在 WSL 里，`.wslconfig` 的 `networkingMode=mirrored` 让
`127.0.0.1:8888` 直接指向 Windows 上的 Unsloth，不需要 portproxy 或局域网开关。

## 安全说明

- 模型、提示词和生成结果都留在本机。
- 检测模型只读取 `/v1/models`，不会修改配置。
- 不要把 `8888` 暴露到局域网；跨机访问请走 `llm2.ioteyeinc.com`（FRP，仍需要 API Key）。
