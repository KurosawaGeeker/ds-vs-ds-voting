# 投票源码仓库工作规则

- 这是独立的源码仓库。原站脱敏版本用于复盘，快照版本用于参考；不要混称高峰期线上版本、已经采用的修复或已验证的生产服务。
- 阅读根目录 README 和目标示例的 README 后再修改。架构、公共接口或轮询调整需按 [Cloudflare 成本审查 Skill](https://github.com/KurosawaGeeker/cloudflare-cost-playbook/blob/docs/cloudflare-cost-playbook/SKILL.md)审查计费路径；它的资源和费用计算器留在规则仓库，不在这里重复维护。
- 保持默认公开路由、后台发布和支付关闭。仓库本身不授权部署、创建资源、改生产数据或线上负载；遵循用户当前的明确授权。
- 不加入账号 ID、真实数据库绑定、密钥、Cookie、真实 IP、私人身份材料和原站第三方图片。公开配置使用占位值，测试使用合成数据。
- 改动 `original-voting-site/` 后运行其中的 `npm run check`、`npm test`；改动 `voting-snapshot/` 后运行其中的 `npm run check`、`npm test`，影响演示时运行 `npm run demo:check`。包检查在根目录运行 `python3 tools/check_package.py`。
- 写票必须可靠持久化且幂等后再确认；公共快照不放个人状态。区分减少 SQL、减少回源和减少 Worker 入站调用；要求全局账单告警和可验证的降级流程。
- Branch、commit、PR title 使用 Conventional Commits；commit 至少满足 `type(scope): subject`。提 PR 或 issue 前检查是否有模板，并注明本地、部署、线上和费用验收的实际状态。
