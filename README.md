# Cloudflare Voting Examples

投票网站的独立开源源码仓库，包含原站脱敏代码和读写分离参考实现。事故文章、成本审查 Skill、AGENTS.md 模板和费用计算器在 [Cloudflare Cost Playbook](https://github.com/KurosawaGeeker/cloudflare-cost-playbook) 中维护。

规则仓库只引用这里，不用 submodule 或脚本自动拉取源码。需要研究或运行示例时，再单独克隆：

```sh
git clone https://github.com/KurosawaGeeker/cloudflare-voting-examples.git
cd cloudflare-voting-examples
```

## 选择你要看的代码

| 目录 | 用途 | 票数读取 |
|---|---|---|
| [original-voting-site](original-voting-site/README.md) | 对照事故中的轮询、数据库与缓存逻辑 | GET 先进入 Worker，再查内部 Cache API |
| [voting-snapshot](voting-snapshot/README.md) | 参考公共快照与动态写票分离的实现 | 浏览器读独立快照入口，投票 POST 进入 Worker |

原站副本来自所有者本地工作区，不能声称唯一还原了高峰期线上 release。快照实现经过本地运行时验证，没有替原站完成云端迁移；真实 CDN、WAF、Turnstile 和计费效果仍需验收。

## 本地使用

使用 Node.js 24+，安装依赖前阅读对应 README。两个目录独立安装和测试：

```sh
cd original-voting-site
npm ci
npm run check
npm test
```

```sh
cd voting-snapshot
npm ci
npm run check
npm test
npm run demo:check
npm run demo
```

以上 `cd` 均从仓库根目录开始。快照演示在 `http://127.0.0.1:8788/`，只使用本地 D1/R2 和验证桩；不模拟真实 CDN 或机器人识别。公开路由、真实支付和定时发布默认关闭。不要把本地测试令牌或占位资源用于生产。

根目录包检查：

```sh
python3 tools/check_package.py
```

具体检查与来源见 [verification.md](verification.md)。架构和费用审查请使用规则仓库的 [Skill](https://github.com/KurosawaGeeker/cloudflare-cost-playbook/blob/docs/cloudflare-cost-playbook/SKILL.md)；源码仓库不复制费用计算器，避免两份价格和规则漂移。

代码与原创说明采用 [MIT](LICENSE)，素材和来源边界见 [NOTICE](NOTICE.md)。提交前读 [AGENTS.md](AGENTS.md)，不要加入账号凭据、真实 IP、原站私有数据或未经许可的绘画。
