# CloakBrowser 模式（`--cloak`）

`--cloak` 是 js-reverse-mcp 的一个**可选**启动开关，用于调试强反爬站点。它启用 [CloakBrowser](https://github.com/CloakHQ/CloakBrowser) 团队定制、按平台提供源码层指纹 patch 的 Chromium 二进制，与默认的 Patchright 协议层 stealth 叠加，形成**双层反检测**。

## 何时该用 `--cloak`

| 场景                                                            | 推荐                                             |
| --------------------------------------------------------------- | ------------------------------------------------ |
| 调试自己的应用 / 公司内部系统                                   | **默认模式**（不加 `--cloak`）                   |
| 调试一般 SaaS / 电商 / 社交站点                                 | **默认模式**                                     |
| 调试 Cloudflare Turnstile / FingerprintJS / DataDome 防护的站点 | **`--cloak`**                                    |
| 需要登录 Google 服务（Gmail、Google Docs 等）                   | **默认模式**（cloak 二进制不带 Google 闭源服务） |
| 需要使用你电脑上已装的 Chrome 扩展                              | **默认模式**（cloak 没有 Chrome Web Store）      |

**简单原则**：99% 的调试用默认模式（系统 Chrome + Patchright）；只有具体被反爬拦截时再开 `--cloak`。

## 启用方式

在 MCP 配置里加 `--cloak`：

```json
{
  "mcpServers": {
    "js-reverse": {
      "command": "npx",
      "args": ["js-reverse-mcp", "--cloak"]
    }
  }
}
```

### **强烈推荐：先预下载二进制**

第一次启用 `--cloak` 时，MCP 会**静默下载 ~200MB** 的 CloakBrowser 二进制（缓存到 `~/.cloakbrowser/`，之后启动零延迟）。但在 MCP 协议下这个下载过程**没有进度反馈**，看起来像 MCP 卡住了 30–60 秒。

**最佳实践：把这一步从 MCP 上下文里拿出来，单独跑一次**：

```bash
npx cloakbrowser install
```

`cloakbrowser` 包已经作为 `js-reverse-mcp` 的 `optionalDependencies` 自动装在 npm 缓存里，这条命令只是触发它自带的二进制下载逻辑（有 stdout 进度条 + SHA-256 校验）。跑完之后再开 MCP 用 `--cloak`，启动直接秒过。

## 双层反检测架构

```
┌────────────────────────────────────────────────────────┐
│ 站点 JS 能看到的表面                                   │
├────────────────────────────────────────────────────────┤
│ 协议层：Patchright                                     │
│  • 不调用 Runtime.enable（避免最经典的 CDP 检测）       │
│  • 不调用 Console.enable                                │
│  • 默认在 isolated execution context 里执行 evaluate    │
│  • 移除 --enable-automation 等可探测的 launch flag      │
├────────────────────────────────────────────────────────┤
│ 源码层：CloakBrowser 二进制（按平台提供 C++ patch）     │
│  • navigator.webdriver = false（属性存在，匹配真实 Chrome）│
│  • canvas / WebGL / audio / fonts 源码级 spoofing       │
│  • GPU 字符串、屏幕尺寸从 fingerprint seed 派生         │
│  • TLS / JA3 / JA4 指纹与真实 Chrome 一致               │
└────────────────────────────────────────────────────────┘
```

两层都不需要 JS 注入。任何 `Object.defineProperty` 风格的反检测 hack 反而会成为指纹信号 —— 我们彻底避免。

## 平台 profile

js-reverse-mcp 直接继承当前 CloakBrowser 的平台默认值：macOS 使用原生 macOS profile，Linux/Windows 使用上游选择的 Windows desktop profile。这样平台、GPU、UA 与对应二进制保持一致；MCP 只替换随机 fingerprint seed，使同一个持久化 profile 在多次启动间保持稳定身份，并移除不适合桌面调试的 `--no-sandbox`。

CloakBrowser 的二进制版本和 patch 覆盖会随平台、版本变化，因此这里不固定声明 patch 数量。若目标站点在某个平台仍被拦截，应以该站点的实际结果为准，并对比系统 Chrome 默认模式，而不是手工强制另一个 OS profile。

## 跟默认模式的差异

| 维度                   | 默认（系统 Chrome）                           | `--cloak`（CloakBrowser 二进制）             |
| ---------------------- | --------------------------------------------- | -------------------------------------------- |
| 浏览器二进制           | 系统装的 Google Chrome                        | 从 Chromium 开源代码编译的隐身版             |
| Chrome Web Store       | ✅ 有                                         | ❌ 无（Chromium 不含 Google 闭源服务）       |
| Google sync / 账号集成 | ✅                                            | ❌                                           |
| 你电脑上已装的扩展     | ✅ 全部可见                                   | ❌ 不可见                                    |
| Widevine DRM           | ✅                                            | 需自行侧载 Widevine CDM                      |
| 指纹防护               | 协议层（Patchright）                          | 协议层 + 源码层（按平台提供 C++ patch）      |
| 启动速度               | 快                                            | 首次下载 ~30-60s，之后正常                   |
| 反爬通过率             | 中等                                          | 高（30+ 检测站测试通过）                     |
| 持久化 profile 路径    | `~/.cache/chrome-devtools-mcp/chrome-profile` | `~/.cache/chrome-devtools-mcp/cloak-profile` |

**关键：两个模式的 profile 目录物理隔离**，互不污染。不同 Chromium 版本的 cache/extension state 混在一起会破坏启动。

## Profile 与指纹身份的关系

`--cloak` 模式下，每个 profile 目录绑定一个**持久化的虚拟身份**：

- 首次启动：随机生成 fingerprint seed（10000–99999 范围），写入 `<profile>/.cloak-seed`
- 之后启动：读取同一个 seed，**呈现完全相同的指纹**（canvas / WebGL / GPU / 屏幕全部一致）
- 模拟「同一个虚拟设备多次访问同一个站点」 —— 比每次随机更不可疑

### 想换一个全新身份

删掉 seed 文件，下次启动重新生成：

```bash
rm ~/.cache/chrome-devtools-mcp/cloak-profile/.cloak-seed
```

### 想要一次性、不留痕

加 `--isolated`：

```bash
npx js-reverse-mcp --cloak --isolated
```

每次启动是临时 profile + 临时随机 seed，浏览器关掉自动清理。

## 验证 `--cloak` 是否生效

启动后，通过 MCP 工具调用 `evaluate_script`：

```javascript
() => ({
  ua: navigator.userAgent,
  webdriver: navigator.webdriver,
  platform: navigator.platform,
  plugins: navigator.plugins.length,
});
```

预期输出：

```json
{
  "ua": "...Chrome/145.0.0.0 Safari/537.36",
  "webdriver": false,
  "platform": "MacIntel",
  "plugins": 5
}
```

UA 里的 `Chrome/145.0.0.0` 是 cloak 二进制的版本（你系统 Chrome 的版本通常更新，比如 142+）。版本不一致就证明 cloak 起作用了。

要更严格地验证反爬效果，访问这些站点：

- https://abrahamjuliot.github.io/creepjs/ — 综合指纹 trust score
- https://bot.sannysoft.com/ — 自动化检测矩阵
- https://browserscan.net/ — 商业反爬服务

## 双 MCP 实例（推荐配置）

如果你需要同时调普通站点和强反爬站点，配置两个 MCP 实例最干净：

```json
{
  "mcpServers": {
    "js-reverse": {
      "command": "npx",
      "args": ["js-reverse-mcp"]
    },
    "js-reverse-cloak": {
      "command": "npx",
      "args": ["js-reverse-mcp", "--cloak"]
    }
  }
}
```

两个实例：

- profile 物理隔离
- 互相不知道对方存在
- 调哪个站点用哪个

## 故障排除

### macOS Gatekeeper 拦截首次启动

cloak 二进制是 ad-hoc 签名。第一次 macOS 可能挡住：

```bash
xattr -cr ~/.cloakbrowser/chromium-*/Chromium.app
```

### 启动报「Connection closed」/ session 异常

通常是 profile 目录有跨浏览器残留（之前别的 Chromium 版本写过的 cache）。物理隔离的 cloak profile 不应该出现这问题，但万一遇到：

```bash
rm -rf ~/.cache/chrome-devtools-mcp/cloak-profile/
```

下次启动会重新创建。

### 二进制下载失败

cloakbrowser.dev 主站访问慢时，cloakbrowser 包会自动回退到 GitHub Releases。也可以手动设环境变量：

```bash
# 自定义下载镜像
export CLOAKBROWSER_DOWNLOAD_URL=https://your-mirror.example.com

# 或直接指向本地已有的 Chromium 二进制
export CLOAKBROWSER_BINARY_PATH=/path/to/your/Chromium
```

### 强反爬站点仍被拦

cloak 二进制只解决**指纹层**反爬。如果还被拦，通常是另一类问题：

1. **IP 信誉差**：数据中心 IP 会被 IP-reputation 数据库标记 → 用住宅代理
2. **行为分析触发**：你执行操作太快、太机械 → 这超出 MCP 调试场景，得用人类节奏操作
3. **TLS 指纹**：cloak 二进制 TLS 指纹跟真实 Chrome 一致，正常不会被这一项拦

## 进一步阅读

- CloakBrowser 项目：https://github.com/CloakHQ/CloakBrowser
- Patchright 项目：https://github.com/Kaliiiiiiiiii-Vinyzu/patchright-nodejs
- 本项目的反检测分层全景：[anti-detection-work.md](anti-detection-work.md)
