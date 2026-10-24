# dsh-turn-budget

**给 DeepSeek Harness 的花费熔断** —— 6 分钟滑动窗口内，token 估算或真实余额任一超阈值，新的模型请求就停在闸门里；窗口滑回阈值以下，自动放行。

> Spend circuit breaker for DeepSeek Harness: a 6-minute sliding window over a token estimate and the real account balance parks new model requests before they run away.

## 安装

**要求**：DSH 0.2.x。

### 方式 A：直接在 DSH 里让它装（最省事，推荐）

对 DSH 说：

> 帮我安装这个插件：https://github.com/yl07003/dsh-turn-budget

它会自己下载并安装，装完提示你重启 ✓ —— 不需要你知道命令、也不需要自己配网络 ✓。

### 方式 B：DSH 插件界面

DSH → **插件** → **安装** → 输入框填 `https://github.com/yl07003/dsh-turn-budget` → 点安装 → 重启 DSH。

### 方式 C：命令行（本机有 Node/npm 时）

```powershell
dsh plugin --profile desktop add "github:yl07003/dsh-turn-budget"
# 没有 dsh 命令时：
npx @deepseek-ai/dsh plugin --profile desktop add "github:yl07003/dsh-turn-budget"
```

`desktop` 换成你自己的 profile 名（不确定就看 `~/.dsh/profiles/` 下的目录名）。

### 方式 D：网络装不上时（zip / 本地目录）

1. 下载 [dsh-turn-budget-v1.0.1.zip](https://github.com/yl07003/dsh-turn-budget/releases/download/v1.0.1/dsh-turn-budget-v1.0.1.zip)（Release 页面里也有）；
2. 解压到任意目录 —— **保证这一层目录里直接有 `package.json`**；
3. DSH → 插件 → 安装 → 填**那个目录的路径** → 重启。

### 卸载

```powershell
dsh plugin --profile desktop remove dsh-turn-budget
```

（也可以在 DSH 的插件界面里卸载，或直接对它说"卸载 dsh-turn-budget"。）

装好后：输入框上方多出两行（熔断状态 + 余额/花费），并出现 `谷`/`峰` 徽章。

## 它做什么

- **双源熔断**：一路 token 估算（每步实时，实测约为真实花费的 90%），一路真实余额（官方账户服务，8 位精度）—— 任一超阈值即挂起新请求；
- **挂起不是丢弃**：请求停在闸门里，窗口滑回后继续（**不会**打断已经发出去的请求）；
- **阈值可改**：输入框上方那两行里直接编辑，存 `~/.dsh/turn-budget.json`；
- **峰谷计价**：北京时间工作日 09:00–12:00 / 14:00–18:00 为峰时，内置**中国法定节假日表**（含临期提醒）。

## 界面上你会看到

输入框上方两行（示意）：

```
不自残：估算/余额各满一个阈值就停一次
余额 ¥109.25   -0.13   6分钟 ¥0.007   花费 ¥0.052   阈值 7 / 10   谷
```

- `谷` / `峰` 徽章：悬停可见判定口径与假期表覆盖范围；
- 余额数字颜色：**深绿** = 官方账户源，**紫** = API key 回退。

## 它保证不了什么

1. **`花费` 和 `余额 -x.xx` 不是同一口径**：前者是 6 分钟**估算**，后者是 6 分钟**真实跌幅**、平台分批落账（晚 1–3 分钟）。**同一瞬间差几倍是正常的** ✗，要验证准确性请拉长到 ≥15 分钟再比；
2. **已在飞的请求不会被打断**（闸门只在请求发出前检查）；
3. **只保护本机这个 DSH 进程**，管不到别的客户端或别的机器；
4. **压缩摘要、标题生成等旁路花费不进会话日志**，估算看不到，只能靠真实余额兜；
5. 它是「**防失控**」，不是「精确预算」。

## 兼容性

`0.1.5-rc.3 → 0.1.7-rc.2 → 0.2.0-rc.1 → 0.2.1-rc.2`，**四次 DSH 升级均无需改代码**。

## 更多

界面逐项说明、全部参数、能力边界全表、双源原理与实测数据：见 [MANUAL.md](./MANUAL.md)。

## License

MIT © 2026 yl07003