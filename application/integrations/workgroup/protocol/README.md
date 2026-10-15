# Client Protocol

服务端 `server/contracts/` 为权威 OpenAPI/JSON Schema。此目录存应用端生成的客户端接口与运行时校验，不另建 shared/contracts 项目，不在 app 侧直接定义后台数据规则。
