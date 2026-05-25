# btblog（梭哈 + 宝塔 + Cloudflare 隧道）

从 Argoblog 拆出的独立部署目录，集成：

- **梭哈 / Xray + Cloudflare Quick Tunnel**（订阅节点）
- **宝塔面板**非交互安装与管理口临时隧道
- **Web 管理面板**（管理员登录、服务控制、日志、端口绑定）

---

## 快速开始

### 本地 / 服务器

```bash
npm install          # 仅依赖 express
export ADMIN_PASSWORD='你的强密码'   # 必填，否则管理 API 不可用
export PORT=3000     # 本地调试；Azure 会自动注入 PORT
npm start
```

浏览器访问：

| 地址 | 说明 |
|------|------|
| `/` | 公开 Welcome 页 |
| `/admin` | 管理员登录 |
| `/admin/panel` | 控制面板（需登录） |
| `/xxxooo` | **公开**订阅链接（读 `v2ray.txt`） |
| `/healthz` | 健康检查（Azure Always On） |

### Azure Linux Web App

1. 部署方式：Git / ZIP / GitHub Actions，启动命令 **`npm start`**（不要把 App Service Startup Command 改成 `cloudflared-linux tunnel run`，否则 Node Web 进程不会监听 Azure 注入的 `PORT`）
2. **配置 → 应用程序设置** 至少设置 `ADMIN_PASSWORD`
3. **配置 → 常规设置** 开启 **Always On**，Health check path = `/healthz`
4. 应用启动后 `entrypoint.sh` 会自动后台跑 `suoha.sh` 与 `install-baota.sh`

---

## 环境变量一览

### 必填（生产）

| 变量 | 说明 |
|------|------|
| `ADMIN_PASSWORD` | 管理面板登录密码。未设置时 `/admin` 无法登录，受保护 API 返回 503 |
| `PORT` | HTTP 监听端口。Azure 平台自动注入；本地默认代码里为 `443`，建议本地设 `3000` |

### 管理员与会话

| 变量 | 默认 | 说明 |
|------|------|------|
| `ADMIN_USERNAME` | `admin` | 管理面板登录用户名 |
| `SESSION_SECRET` | 随机生成 | 会话 Cookie 签名密钥；不设则**每次进程重启**所有登录失效 |
| `ADMIN_SESSION_HOURS` | `24` | 登录会话有效期（小时） |
| `ADMIN_COOKIE_SECURE` | 自动 | `true` / `false` 强制 Secure Cookie；Azure 生产环境一般自动为 true |

### 运行时目录

| 变量 | 默认 | 说明 |
|------|------|------|
| `ARGO_RUNTIME_DIR` | 应用根目录 | 日志、`v2ray.txt`、`cloudflared-linux`、`baota-*.log` 等写入位置。Azure 上通常为 `/home/site/wwwroot` |

### 宝塔安装

| 变量 | 默认 | 说明 |
|------|------|------|
| `BT_INSTALL_URL` | `https://bt.cxinyun.com/install/install_panel.sh` | 宝塔官方安装脚本下载地址 |
| `BT_PORT` | `8888` | 首次生成 `baota-settings.json` 时使用的面板端口 |
| `BT_SAFE_PATH` | 自动生成 | 首次生成 `baota-settings.json` 时使用的安全入口，如 `/btblog-ab12cd34` |
| `BT_USERNAME` | `btadmin` | 首次生成 `baota-settings.json` 时使用的宝塔用户名 |
| `BT_PASSWORD` | 自动生成 | 首次生成 `baota-settings.json` 时使用的宝塔密码 |

> **不做持久化：** 宝塔装在容器系统盘 `/www`，重启后丢失。检测到面板不存在时会清除 `.baota-installed` 并**重新安装**（约 10–30 分钟）。保活每 3 分钟检查，或面板内点「启动宝塔」。
>
> **固定配置：** 管理面板「宝塔」页可编辑端口、安全入口、用户名和密码，保存到 `baota-settings.json`。后续安装、重装、重启都会读取该文件并重新应用，避免每次安装后入口和账号变化。

### 端口临时隧道

| 变量 | 默认 | 说明 |
|------|------|------|
| `MAX_PORT_TUNNELS` | `8` | 管理面板「端口绑定」最多同时绑定的端口数 |

### Cloudflare 固定隧道（Named Tunnel）

固定隧道通过后台面板写入 `named-tunnel-settings.json` 后启用。程序不会在启动时自动拉起固定隧道；保存配置后再点击「启动固定隧道」，节点 / 宝塔 / 端口绑定共用同一个 `cloudflared` 进程。

| 配置项 | 默认 | 说明 |
|------|------|------|
| Tunnel Token | 无 | Cloudflare 控制台创建隧道后给出的 `cloudflared tunnel run --token ...` 中的 token |
| API Token | 无 | 用于保存配置时通过 Cloudflare API 推送 ingress 路由 |
| Account ID | 无 | Cloudflare 账户 ID，用于 API 推送路由 |
| Tunnel ID | 无 | Cloudflare Tunnel UUID，用于 API 推送路由 |
| 节点域名 | 无 | 如 `node.example.com` |
| 宝塔域名 | 无 | 如 `bt.example.com` |
| 端口域名后缀 | 无 | 端口绑定域名后缀；绑定 8080 时默认生成 `p8080.example.com` |
| 端口子域名前缀 | `p` | 最终为 `{prefix}{port}.{TUNNEL_PORT_DOMAIN}` |
| Xray 端口 | `10086` | Xray 固定监听端口（不再随机） |
| 宝塔端口 | `8888` | 宝塔面板端口回退值；优先读取 `/www/server/panel/data/port.pl` |

未保存固定隧道配置时，仍回退到 Quick Tunnel（临时 `trycloudflare.com`）模式。

### Node 版本

| 变量 | 要求 |
|------|------|
| （package.json `engines`） | Node **22.x**（`>=22 <23`） |

---

## 启动流程

```
npm start
  └─ index.js 启动 Express
  └─ entrypoint.sh（后台）
       ├─ suoha.sh（后台）→ xray + cloudflared → v2ray.txt
       └─ install-baota.sh（后台）→ 安装/重装宝塔 + baota-panel-tunnel
  └─ 保活定时器
       ├─ 梭哈：每 45 秒
       └─ 宝塔：每 3 分钟
```

---

## 页面与 API

### 公开（无需登录）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/` | Welcome 欢迎页 |
| GET | `/xxxooo` | 订阅链接纯文本（`v2ray.txt`） |
| GET | `/healthz` | 进程存活 |
| GET | `/readyz` | 进程 + Xray/Cloudflared 是否都在跑 |
| POST | `/admin/login` | 登录（body: `username`, `password`） |
| GET | `/admin/session` | 当前是否已登录 |

### 需管理员登录

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/admin/panel` | Web 控制面板 HTML |
| GET | `/suoha-status` | Xray / Argo 进程状态 |
| POST | `/start-suoha` | 启动梭哈 |
| POST | `/restart-suoha` | 重启梭哈 |
| POST | `/stop-suoha` | 停止梭哈 |
| GET | `/v2ray-info` | 订阅内容（JSON） |
| GET | `/server-info` | 系统与出口信息 |
| GET | `/logs` | 系统/进程/各日志文件 |
| GET | `/baota-info` | 宝塔状态 + 登录信息 + 日志 |
| GET | `/baota-settings` | 读取固定宝塔配置（不返回密码明文） |
| POST | `/baota-settings` | 保存固定宝塔配置并后台应用 |
| POST | `/start-baota` | 后台执行 install-baota.sh |
| GET | `/port-tunnels` | 已绑定端口隧道列表 |
| POST | `/port-tunnels/bind` | `{ "port": 8080, "protocol": "http" }` |
| POST | `/port-tunnels/unbind` | `{ "port": 8080 }` |
| POST | `/admin/logout` | 退出登录 |

---

## 运行时文件（`ARGO_RUNTIME_DIR` 下）

| 文件 / 目录 | 说明 |
|-------------|------|
| `suoha.sh` | 梭哈脚本（部署包自带，entrypoint 不覆盖） |
| `suoha-start.log` | Node 侧启动梭哈的日志 |
| `suoha.log` | suoha.sh 标准输出 |
| `xray/` | Xray 二进制与配置 |
| `xray.log` | Xray 日志 |
| `cloudflared-linux` | Cloudflared 二进制（梭哈/宝塔/端口绑定共用） |
| `argo.log` | 梭哈用 Cloudflared 日志 |
| `v2ray.txt` | 生成的订阅链接 |
| `baota-install.log` | 宝塔安装与启动日志 |
| `baota-argo.log` | 宝塔管理口隧道日志 |
| `baota-panel-url.txt` | 宝塔外网 + 本地地址、默认账号 |
| `baota-default.txt` | `bt default` 或面板路径信息 |
| `baota-settings.json` | 固定宝塔端口、安全入口、用户名和密码 |
| `.baota-installed` | 安装成功标记（**仅当次容器生命周期有效**） |
| `port-tunnels.json` | 端口绑定状态 |
| `port-tunnel-{端口}.log` | 各端口隧道日志 |

---

## 梭哈（Xray + Argo）

- `entrypoint.sh` 启动后后台执行 `suoha.sh`
- 若 `xray/xray`、`cloudflared-linux` 已存在且可执行，**跳过下载**
- 订阅地址：部署域名 + `/xxxooo`（**公开，无需登录**）
- 管理面板「V2Ray 链接」标签页需登录后查看

---

## 宝塔面板

- 非交互：`yes | bash install_panel.sh`
- 安装到 **`/www`**（系统 overlay，Azure 上约 34GB，与 1GB 的 `wwwroot` 无关）
- 安装完成后 Cloudflare Quick Tunnel 暴露 HTTPS 管理口（`trycloudflare.com`，临时地址）
- **容器重启后面板丢失 → 自动重装**，不迁移到 `wwwroot`
- 需要 **root** 与完整 Linux；标准 App Service 沙箱可能失败，建议自定义容器或 VM

保活逻辑：必须 **面板进程 + 宝塔隧道 + 有效外网 URL** 三者同时满足才视为就绪，否则触发 `install-baota.sh`。

---

## 端口隧道

管理面板 **端口绑定** 标签：为 `127.0.0.1:端口` 暴露外网访问。

- **未配置 token**：Quick Tunnel，地址形如 `https://xxx.trycloudflare.com`，重启后可能变化
- **已配置 `CLOUDFLARE_TUNNEL_TOKEN`**：固定域名，形如 `https://p8080.example.com`，绑定/解绑时程序自动更新本地 `cloudflared-config.yml`

---

## Cloudflare 固定隧道配置步骤

> **Tunnels 和 Zero Trust 是同一套 Cloudflare Tunnel。** 新版入口在网站 Dashboard 的 **Networks → Connectors → Cloudflare Tunnels**；旧入口在 Zero Trust → Networks → Tunnels，两者等价。

1. 在 Cloudflare 添加并托管你的域名（如 `example.com`）
2. **Networks → Connectors → Cloudflare Tunnels → Create**，类型选 Cloudflared
3. 创建完成后复制安装命令里的 **token**（`eyJhIjoi...` 整段）
4. 在隧道详情页记下 **Tunnel ID**（UUID）
5. 到 **DNS → Records** 添加 CNAME（程序默认用本地 ingress，**不必**在隧道里逐条配 Public Hostname）：
   - `node.example.com` → `<tunnel-id>.cfargotunnel.com`
   - `bt.example.com` → `<tunnel-id>.cfargotunnel.com`
   - 端口绑定建议加通配符：`*.example.com` → `<tunnel-id>.cfargotunnel.com`（配合默认 `p8080.example.com` 规则）
6. 部署后打开后台面板 → 固定隧道，填写 Tunnel Token、API Token、Account ID、Tunnel ID、节点域名、宝塔域名和端口域名后缀
7. 点击「保存配置」写入 `named-tunnel-settings.json`，程序会尝试通过 Cloudflare API 推送路由
8. 点击「启动固定隧道」后才会启动名为 `btblog-named-tunnel` 的进程

若不填写 API Token，保存配置只写本地文件，不会通过 Cloudflare API 创建或更新路由。

---

## Azure 磁盘说明（参考）

| 挂载点 | 典型容量 | 持久？ | 本项目用途 |
|--------|----------|--------|------------|
| `/home`（`wwwroot`） | ~1GB | 是（同实例） | 代码、订阅、日志、cloudflared |
| `/` overlay | ~34GB | 否 | 宝塔 `/www` 安装（重启丢失） |
| `/appsvctmp` | ~62GB | 临时 | 未使用（不做宝塔持久化） |

---

## 测试（`test/`）

### 为什么仓库里有 `test/`？

`test/` 是**开发用单元测试**，和源码一起提交到 Git，方便：

- 本地改代码后跑 `npm test` 确认没改坏
- CI（如 GitHub Actions）可选接入

**不会在 Azure 生产环境自动执行**——`npm start` 只跑 `node index.js`，不跑测试。部署到 App Service 不会因为你 push 了 test 就在服务器上跑测试。

### 如何运行

```bash
npm test
# 等价于
node test/run-tests.js
```

无需额外测试依赖，使用 Node 内置 `assert`。

### 测试覆盖

| 文件 | 内容 |
|------|------|
| `package.test.js` | Node 版本、依赖声明 |
| `runtime.test.js` | `ARGO_RUNTIME_DIR` 解析 |
| `service-manager.test.js` | 梭哈进程状态、保活、并发启动 |
| `auth.test.js` | 登录、会话、鉴权中间件 |
| `baota-manager.test.js` | 宝塔状态解析、安装标记 |
| `port-tunnel-manager.test.js` | 端口校验、trycloudflare URL 解析 |
| `ui-structure.test.js` | 控制面板 HTML 结构 |
| `public-pages.test.js` | Welcome / 登录页结构 |

### 若不想在部署包里带 test

Azure Git 部署会整仓拉取，包含 `test/` 目录，但**仅占磁盘、不参与运行**。若需排除，可在 `.gitignore` 或部署脚本里删掉，**不建议**——体积很小，保留有利于后续维护。

---

## 目录结构

```
btblog/
├── index.js              # Express 入口
├── entrypoint.sh         # 启动 suoha + 宝塔脚本
├── suoha.sh              # Xray + Cloudflared 梭哈
├── install-baota.sh      # 宝塔安装 + 管理口隧道
├── lib/
│   ├── auth.js           # 管理员会话
│   ├── baota-manager.js  # 宝塔任务与状态
│   ├── port-tunnel-manager.js
│   ├── service-manager.js
│   └── runtime.js
├── public/
│   ├── welcome.html
│   └── admin-login.html
├── views/
│   └── panel.html        # 管理面板（不静态暴露）
├── test/                 # 单元测试（见上文）
└── package.json
```

---

## 免责声明

* 本程序仅供学习了解，非盈利目的，请于下载后 24 小时内删除，不得用作任何商业用途。
* 使用本程序须遵守部署服务器所在地、所在国家和用户所在国家的法律法规，程序作者不对使用者任何不当行为负责。
