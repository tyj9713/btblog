# btblog（宝塔 + Argo 隧道）

本目录从 Argoblog 拆出，专用于 **宝塔面板非交互安装** 与 **管理口 Cloudflare 隧道**。原 Argo/梭哈能力保留。

## 管理员访问控制

- 公开首页：`/` 显示 Welcome 欢迎页。
- 管理入口：`/admin` 登录后进入 `/admin/panel` 控制面板。
- 所有管理 API（状态、日志、启动/停止、宝塔信息等）均需登录后访问。
- 健康检查 `/healthz`、`/readyz` 保持公开，供 Azure Always On 使用。

在 Azure 应用服务 **配置 → 应用程序设置** 中添加：

| 变量 | 必填 | 说明 |
|------|------|------|
| `ADMIN_PASSWORD` | 是 | 管理员登录密码 |
| `ADMIN_USERNAME` | 否 | 用户名，默认 `admin` |
| `SESSION_SECRET` | 否 | 会话签名密钥；未设置时每次重启会重新生成 |
| `ADMIN_SESSION_HOURS` | 否 | 会话有效期（小时），默认 `24` |

## Azure Web App 运行建议

- 建议部署到 Linux Web App，启动命令保持 `npm start`。
- 在 Azure Portal 开启 `Always On`，Health check path 配置为 `/healthz`。
- 运行时文件默认写入应用部署目录，和 `suoha.sh`、`v2ray.txt`、`xray`、`cloudflared-linux` 保持在同一处；如需单独目录，可通过环境变量 `ARGO_RUNTIME_DIR` 覆盖。
- `xray/xray` 与 `cloudflared-linux` 已存在且可执行时，`suoha.sh` 会跳过对应组件的下载/解压；`entrypoint.sh` 不再用旧模板覆盖 `suoha.sh`。
- `/logs` 会返回 `suoha-start.log`、`suoha.log`、`xray.log`、`argo.log`，用于排查启动失败原因。
- `/healthz` 只检查 Node 进程是否存活；`/readyz` 会额外检查 Xray 和 Cloudflared 进程状态。
- 启动和重启服务会立即返回，实际进度通过页面状态、`/suoha-status`、`/logs` 查看。

## 宝塔面板全自动安装

拉取代码后由 `entrypoint.sh` 自动后台执行 `install-baota.sh`，无需人工输入 `y`：

- 使用 `yes | bash install_panel.sh` 非交互安装（源地址可通过 `BT_INSTALL_URL` 覆盖）。
- 安装完成后读取 `/www/server/panel/data/port.pl` 与 `admin_path.pl`，用 Cloudflare Quick Tunnel 暴露 HTTPS 管理口。
- 外网地址写入运行目录 `baota-panel-url.txt`；默认账号信息在 `baota-default.txt`（`bt default` 输出）。
- API：`GET /baota-info`、`POST /start-baota`；日志字段见 `GET /logs`。

**注意：** 宝塔需要 root 权限及完整 Linux 环境。标准 Azure App Service 沙箱可能无法安装；建议使用带 root 的 VM / 自定义容器。首次安装可能耗时 10–30 分钟，请查看 `baota-install.log`。

**容器重启：** 系统盘 `/www` 与 `/usr/bin/bt` 可能丢失。安装成功后会将宝塔目录迁移到运行目录下的 `baota-www-root` 并重建 `/www` 符号链接；重启后自动恢复。若持久化目录也不存在，将清除 `.baota-installed` 标记并触发重新安装。

## 端口临时隧道绑定

管理面板 **端口绑定** 标签页可为本地任意端口创建 Cloudflare Quick Tunnel（`trycloudflare.com`）：

- 输入端口（如 `8080`），选择 HTTP/HTTPS，点击 **绑定端口**。
- 成功后显示外网访问 URL；支持解绑、查看隧道日志。
- API：`GET /port-tunnels`、`POST /port-tunnels/bind`、`POST /port-tunnels/unbind`（均需管理员登录）。
- 默认最多同时绑定 8 个端口，可通过环境变量 `MAX_PORT_TUNNELS` 调整。
- 依赖运行目录下的 `cloudflared-linux`；若不存在会自动下载。

**注意：** 临时隧道地址可能随进程重启变化，不保证长期稳定，仅供测试使用。




## 免责声明:
* 本程序仅供学习了解, 非盈利目的，请于下载后 24 小时内删除, 不得用作任何商业用途, 文字、数据及图片均有所属版权, 如转载须注明来源。
* 使用本程序必循遵守部署免责声明。使用本程序必循遵守部署服务器所在地、所在国家和用户所在国家的法律法规, 程序作者不对使用者任何不当行为负责。
