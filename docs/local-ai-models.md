# 本地 AI 模型接入

OpenCreator 的文本任务支持直接使用本机运行的 OpenAI 兼容模型服务，不需要云端账号或 API Key。

## 内置的本地服务预设

在「设置 → AI 服务 → 模型服务 → 自定义模型服务 → 供应商」中可以直接选择：

| 预设 | 默认 Base URL | 说明 |
| --- | --- | --- |
| LocModel / llama.cpp (local) | `http://127.0.0.1:8686/v1` | LocModel 默认端口来自其 `settings.json` 的 `port` 字段 |
| Ollama (local) | `http://127.0.0.1:11434/v1` | Ollama 的 OpenAI 兼容接口 |
| LM Studio (local) | `http://127.0.0.1:1234/v1` | LM Studio 本地服务器 |
| llama.cpp server (local) | `http://127.0.0.1:8080/v1` | 直接运行 `llama-server` |

选择预设后：

1. 先在本机应用中启动模型，例如在 LocModel 中选择模型并点击启动。
2. 点击「检测模型」。OpenCreator 会请求 `GET {Base URL}/models`，把返回的模型填入模型下拉框。
3. 选择或手动填写模型名称，保存配置。

本地服务使用回环地址（`localhost`、`127.0.0.1`、`::1`）时，API Key 可以留空，界面也不会要求填写。远端地址仍然需要 API Key。

## 工作流实际使用的模型

「模型服务」配置会被以下文本任务使用：

- 视频翻译字幕、封面分析、短视频脚本、小红书文案、公众号文章
- 剪辑分析、火柴人脚本与分镜
- 模板预检中的 Text model 检查

切换服务后需要保存配置。本机 Codex 运行时与本地 OpenAI 兼容服务是两种独立模式，按需切换即可。

## 本地图片与视频生成

LocModel 的图片/视频引擎是 `stable-diffusion.cpp` 的 `sd-server`，同样通过本机端口提供 API：

- 图片：`POST /v1/images/generations`（OpenAI 兼容）
- 视频：`POST /sdcpp/v1/vid_gen` + `GET /sdcpp/v1/jobs/{id}`（原生异步任务）

在 OpenCreator 中配置：

1. 先在 LocModel 里打开「图片」或「视频」，选择一个模型并启动引擎。
2. 设置 → AI 服务 → 图像生成（或视频生成）。
3. 服务商选择 **本地 SD（stable-diffusion.cpp）**。
4. Base URL 默认是 `http://127.0.0.1:8686`；如果 LocModel 使用其他端口，按实际端口修改。
5. 点击 **检测 LocModel 模型**。OpenCreator 会读取 LocModel `settings.json` 中的 `models_dir`，列出 `models_dir/image` 下已下载的图片/视频模型，并优先选中当前引擎已加载的模型。
6. 保存配置。

注意：

- LocModel 可能复用同一个端口运行 LLM 或图片/视频引擎。生成图片/视频前，请先在 LocModel 中切换到对应模式；切回聊天时再启动 LLM 模型。
- 视频默认输出 `webm`，OpenCreator 会按实际 MIME 保存和播放。
- 图片生成目前使用文生图接口；参考图重绘暂未接入。
- 如果 LocModel 的端口不是 `8686`，请直接修改 Base URL，例如 `http://127.0.0.1:8687`。
- 模型列表来自 LocModel 的已下载目录；实际推理仍使用 LocModel 当前启动的模型。切换模型后，请先在 LocModel 中启动对应模型再生成。

## WSL / 容器中的注意事项

如果 OpenCreator Runtime 运行在 WSL 或容器中，`127.0.0.1` 指向的是 WSL/容器自身，而不是 Windows 上的 LocModel。

- 保持 LocModel 的 `lan_access` 关闭时，它只监听 Windows 本机回环地址，WSL 无法访问。
- 需要跨环境访问时，在 LocModel 中开启局域网访问，然后在 OpenCreator 中把 Base URL 改成 Windows 主机地址（例如 WSL 中 `ip route show default` 得到的网关地址，或 `/etc/resolv.conf` 中的 nameserver）。
- 跨环境地址不属于回环地址，界面会要求填写 API Key。LocModel/llama.cpp 不校验该值，可以填写任意占位值（例如 `local`）。

## 安全说明

- 本地服务的模型名称、提示词和生成结果都留在本机，不会经过 OpenCreator 的云端服务。
- 检测模型只读取 OpenAI 兼容的 `/models` 列表，不会修改任何配置。
- 切换到其他 Base URL 时，已保存的文本模型 API Key 不会被带到新地址。
