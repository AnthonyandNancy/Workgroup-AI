# Hub 域模型 / 通信职责

## HTTP 用于状态变更和历史读取

- `POST /api/v1/auth/register` / `POST /api/v1/auth/login` / devices：认证后分配 userId、设备 ID；正式企业模式可增加管理员邀请/注册限制。
- `POST /api/v1/rooms`、`GET /api/v1/rooms`、`POST /rooms/{roomId}/invitations`、`POST /invitations/{id}/accept`。
- `POST /rooms/{roomId}/messages`、`GET /rooms/{roomId}/messages?afterSeq=`，提交消息必须带 clientMessageId 幂等键。
- `POST /rooms/{roomId}/tasks` 创建 **PENDING_APPROVAL**；`POST /tasks/{taskId}/decision` 仅本人可批准/拒绝；`POST /tasks/{taskId}/cancel` 由合法主体取消。
- `GET/POST/PATCH/DELETE /rooms/{roomId}/memories`，按源消息、ACL 与修订历史管理。
- `POST /artifacts` 上传白名单结果，`GET /artifacts/{id}` 在授权范围内下载。

## WSS 用于推送与确认

客户端连接 `/api/v1/realtime`，通过短期 token 认证（禁止把长效令牌放 URL query 或日志），Hello 交换协议版本和 deviceId。消息 `eventId + type + payload + roomId + roomSeq + issuedAt`；客户端返回 ACK，断线后走 HTTP history 补齐缺口。可推送 `message.created`、`invitation.created`、`task.approval_requested`、`task.approved`、`task.cancelled`、`task.progress`、`task.shared`、`group_memory.changed`。

## 数据域

User 与 Device 认证边界、Room/Member ACL 边界、Task/Approval 授权边界、Artifact/Memory 数据共享边界互不等价。Hub 永远不接收本地 botSessionId 作为用户权限凭据，不能根据消息中的 `approved: true` 字段直接启动任务。

## 事务/并发规则

群内 roomSeq 按 roomId 单调递增；消息 clientMessageId 用户+群作用域唯一；任务状态迁移携带 `expectedVersion` 乐观锁，批准不可重复；撤销提升授权 revocationVersion，Bridge 和 BotAdapter 继续执行前必须核对。入站事件先认证后去重再执行状态机；所有任务派发不得通过不受控的 shell 字符串 RPC。
