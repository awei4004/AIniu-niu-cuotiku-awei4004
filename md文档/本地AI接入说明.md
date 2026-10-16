# 本地 AI 接入与 Git 分支

## 当前实现

分支为 `codex/local-ai`，从已有真实 AI 云端接入的 `main` 分出。该版本不需要开通微信云开发，先在微信开发者工具的模拟器里使用。

```text
微信开发者工具中的小程序
  → wx.request → 电脑 http://127.0.0.1:8787/api
  → HTTPS → 配置的 AI 服务商
  → 候选题保存到小程序本地 → 人工确认 → 练习 / PDF
```

学生、错题、候选题和练习记录继续存在小程序缓存中；电脑服务只负责 AI 生成与任务恢复。本次未接入本地真实 OCR，图片识别保持现有演示流程。清理小程序缓存会丢失本地业务数据，电脑端任务文件不能代替错题库备份。

## 1. 填写电脑端配置

打开 `local-server/config.local.json`，填写：

```json
{
  "AI_PROVIDER": "openai-compatible",
  "AI_BASE_URL": "https://你的服务商基础地址/v1",
  "AI_MODEL": "服务商实际模型ID",
  "AI_API_KEY": "你的密钥",
  "AI_TIMEOUT_MS": "45000",
  "AI_MAX_TOKENS": "4096",
  "AI_TOKEN_PARAMETER": "max_tokens",
  "AI_RESPONSE_FORMAT": "json_object",
  "LOCAL_AI_PORT": "8787"
}
```

基础地址由服务商提供，不要重复附加 `/chat/completions`。接口需要兼容非流式 Chat Completions。模型要求 `max_completion_tokens` 时修改 `AI_TOKEN_PARAMETER`；不支持 JSON 响应格式参数时，把 `AI_RESPONSE_FORMAT` 改成 `text`。

配置文件已被 `.gitignore` 排除。新克隆项目首次启动会从 `config.example.json` 自动创建空配置。程序先读取配置文件，再使用同名进程环境变量覆盖配置；修改后需要重启服务。

仅配置齐全不会请求 AI，也不代表认证已通过。`AI_PROVIDER=demo` 可明确启用电脑端演示测试，此时页面显示“演示出题”。

## 2. 启动本地服务

在项目根目录终端运行：

```powershell
npm.cmd install
npm.cmd run dev:ai
```

本项目需要 Node.js 18 或以上版本。首次克隆需要安装已有依赖；已有 `node_modules` 时直接启动即可，本次没有新增第三方依赖。

默认监听 `127.0.0.1:8787`。服务启动后可在浏览器打开 `http://127.0.0.1:8787/health`，应返回 `ok: true`；其中 `ready: false` 表示 AI 配置未完成。健康检查不会调用供应商。

若端口占用，在电脑配置中修改 `LOCAL_AI_PORT`，并同步修改小程序 `localAiBaseUrl` 中的端口。

## 3. 设置小程序

`miniprogram/config/env.js` 已设置为：

```js
module.exports = {
  cloudEnvId: '',
  localAiBaseUrl: 'http://127.0.0.1:8787'
};
```

两个配置都为空时使用原本的本地演示出题；填写云环境时云模式优先。本地 AI 模式不要求云环境 ID。

在微信开发者工具右上角“详情”的“本地设置”中，启用“不校验合法域名、web-view（业务域名）、TLS 版本以及 HTTPS 证书”这一调试选项，然后重新编译。不同工具版本文案可能略有差异。

本版服务只监听电脑回环地址，不支持直接用手机扫码访问，也不作为公网发布方案。手机上的 `127.0.0.1` 指向手机自身。

## 4. 验收

1. 打开原有或新建的错题，进入“生成同类题”。
2. 服务未启动时显示“AI 未连接”，已有候选题仍可查看；启动后点击“重试”。
3. 配置为空时显示“AI 待配置”。配置后重启服务、点击“重试”，显示“AI 出题”。
4. 先生成 1 道数学题，再检查题目、答案和解析，确认后练习并导出 PDF。
5. 请求中断时使用“查询原任务”。电脑保存任务结果，同一请求编号复用结果，避免重复调用。

任务文件位于 `local-server/data/tasks.json`，已被 Git 忽略，包含生成内容。不要在任务未确认时删除它。服务重启会把未完成任务标为中断，不自动再次调用服务商；原请求可能已经计费，请确认后再生成。

AI 接口错误、输出结构和重复题会校验；答案正确性与教学质量仍需人工验收。当前自动化测试使用模拟 AI 返回值和真实本机 HTTP，不代表真实供应商联通已验收。

## Git 使用

当前已经创建并切换到 `codex/local-ai`。创建分支时，已有的未提交 AppID 修改一并保留，没有自动提交。

检查分支及修改：

```powershell
git branch --show-current
git status
git diff
```

确认修改后提交，再切回主线：

```powershell
git add .
git commit -m "feat: add local AI generation server"
git switch main
```

未提交的修改可能跟随分支切换。提交后再切换，才能把这版开发记录固定在该分支中。`config.local.json`、电脑任务数据和日志默认不会加入提交。AppID 属于项目配置，是否一并提交由你决定。

以后继续本地版本：

```powershell
git switch codex/local-ai
npm.cmd run dev:ai
```

若后续希望把这版并回主线，在确认提交和验收后执行：

```powershell
git switch main
git merge codex/local-ai
```
