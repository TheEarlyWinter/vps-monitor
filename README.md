# 小鸡监控（vps-monitor）

面向 HanaAgent 的 Linux VPS 监控 App：通过 Hana 授权的 external runtime 使用 SSH 采集 CPU、内存、SWAP、磁盘、网络和周期流量账本，不在 VPS 上安装常驻探针。

## 当前状态

- 已在 HanaAgent 中完成真实 SSH 联通验证。
- 支持密码认证和 PEM 私钥认证。
- 首次连接和主机密钥变化都必须显式确认指纹。
- 两台 VPS 的真实采样已验证：`online / collecting`。
- 仓库不包含任何服务器地址配置、SSH 凭据、主口令或凭据库数据。

这不是通用桌面 SSH 客户端；运行需要 HanaAgent 的 App runtime 能力。其他用户可以使用，但必须在自己的 HanaAgent 中安装，并自行填写 VPS 配置、凭据和主机指纹。

## 环境要求

- HanaAgent `>= 0.1050.9`
- Node.js `>= 22`（仅用于测试和打包）
- Hana App 权限：`app.resources.read`、`app.runtime.execute`、`app.runtime.network`

## 本地验证

```bash
npm ci
npm test
npm run typecheck
npm run check:runtime
```

## 打包并安装 Hana App

Hana 的本地 App 安装器要求包内依赖存在且不能包含符号链接。先安装依赖，再运行可复现打包脚本：

```bash
npm ci
npm run pack:app -- --output ../vps-monitor-app
```

然后在 HanaAgent 的扩展管理中安装生成的 `../vps-monitor-app` 目录，并确认所需 runtime 权限。

不要直接把开发目录的 `node_modules` 当作发布包；`pack:app` 会复制运行时依赖并实体化符号链接。

## 首次使用

1. 打开“小鸡监控”。
2. 初始化或解锁本地凭据库主口令。
3. 添加 VPS，填写主机、端口、用户名和密码/私钥。
4. 从 VPS 管理面板或可信带外渠道核对 SSH 主机指纹。
5. 只有核对无误后，在 App 中确认指纹。
6. 等待首轮采样完成；首采建立流量账本基线，后续采样计算差分。

主口令和 SSH 凭据只保存到 Hana 的本地加密凭据库，不提交到 Git 仓库。

## 设计边界

- SSH sidecar 只通过 Hana `scoped + external` runtime 建立网络连接。
- 不使用系统 `ssh`、裸 socket、Mock 在线指标或自动接受未知 host key。
- 远程采集使用固定的单行 `VMON/1` 命令，不接受用户在 App 内输入任意 shell 命令。
- 网络中断、SSH 半开连接和远程 exec 挂起会被超时清理并进入重试退避。
- 每个服务器拥有独立 managed runtime service，避免并行采集互相冲突。

## 许可证

MIT License，见 [LICENSE](./LICENSE)。
