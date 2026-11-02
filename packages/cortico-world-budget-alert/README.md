# cortico-world-budget-alert

Cortico World 扩展(api 6)。读本机的 usage 账本,按单价表算出今天花了多少人民币,越过告警线时推一条提醒。**不联网,不用 API Key**,只读本机文件。

## 工具

**`budget_status`**:今天(部署时区的自然日)的花费

```json
{
  "ok": true,
  "date": "2026-11-02",
  "spent": 12.3456,
  "budget": 20,
  "remaining": 7.65,
  "ratio": 0.6173,
  "alertAt": [0.8, 1],
  "fired": [],
  "byModel": { "deepseek-chat": { "calls": 41, "promptTokens": 912000, "cacheHitTokens": 600000, "completionTokens": 88000, "reasoningTokens": 0, "yuan": 0.9480 } },
  "byHour": [0, 0, 0, 0, 0, 0, 0, 0, 0.12, 1.9, "…共 24 项"],
  "unpriced": [],
  "basis": { "charges": 41, "pricing": 0, "unpriced": 0, "partial": 0 },
  "badLines": 0,
  "checkedAt": "2026-11-02T14:03:10.000+08:00"
}
```

`budget` 为 `null` 表示还没设日预算,这时不告警。`unpriced` 里的模型至少有一次调用算不出费用(单价表里没有,或 charges 的币种没设汇率),那些调用不计入 `spent`,所以实际花费比显示的高;`byModel[模型].reasons` 写着原因。`basis` 是按 provider 实扣、按单价表、算不出这三种情况各有多少次调用。

**`budget_set {dailyYuan, alertAt?}`**:设日预算(人民币元)和告警线。`alertAt` 是占预算的比例,1.0 = 100%,缺省 `[0.8, 1.0]`;不给就保留现在的。设完立刻重新检查一次,如果已经越过新的线,会马上提醒。

账本不存在、读不了或格式坏了,两个工具都返回 `{ok:false, reason}`,不抛异常,也不会把花费当成 0。

## 账本从哪来

数据源只有一个:`create(ctx)` 给的 `ctx.dataDir` 下的 `usage.jsonl`,也就是部署目录里的 `data/usage.jsonl`。它是 Cortico Core 自己写的用量账本,每次模型调用追加一行 JSON。本扩展只读这个文件,不猜别的路径,不调任何接口。

用到的字段(都是驼峰):

| 字段 | 用途 |
|---|---|
| `ts` | 调用时间,按部署时区判断是不是今天、落在哪个小时 |
| `model` | 去单价表里查价 |
| `promptTokens` | 输入总量 |
| `cacheHitTokens` | 其中命中缓存的部分;未命中 = `promptTokens - cacheHitTokens` |
| `completionTokens` | 输出总量 |
| `reasoningTokens` | 只用于展示。它是 `completionTokens` 的一部分,不会重复计费 |
| `attempt.charges` / `charges` | provider 实扣的费用,有就优先用它,见下一节 |

另外按 `recordId` 去重:Core 写盘失败重试时可能留下重复行,同一条只算一次。

读取方式:每 60 秒检查一次,按文件大小增量读,只读上次读到的位置之后新增的字节;末尾没写完的半行留到下次再拼。文件变小(被清空)或换了文件就从头读。跨天时为了不漏掉今天的记录会整读一遍。调用 `budget_status` 时也会顺手增量读一次,所以读数总是最新的。

坏行的处理:Core 本身就允许账本里偶尔有一行写撕了(进程中途被杀),这种零星坏行会跳过并在 `badLines` 里计数。坏行超过 5%(且至少 3 行),或者整份账本没有一行能解析,就判定格式坏了,返回 `ok:false`。

## 怎么计费

每条记录按这个顺序算:

1. **有 charges 就用 charges。** 取法和 cortico 自己的 `recordCharges` 一样:先看 `attempt.charges`,没有再看记录上的 `charges`。每笔取 `knownAmount`,按 `quote.currency` 折成人民币:CNY 直接用,USD 乘以配置里的「美元汇率」。`amount` 为 null 的那笔表示有计量项没有价,`knownAmount` 只是下限,读数里记为 `partial`
2. **charges 缺省或是空数组,才回落到单价表**,按 token 数和单价算
3. 两条都走不通的(charges 的币种没设汇率,或单价表里没有这个模型),这次调用记为算不出:不计入 `spent`,也不当成 0,列进 `unpriced`

charges 有但没设汇率时**不会**回落到单价表。单价表是挂牌价,和 provider 实际扣的可能差很多(比如命中缓存的价),回落过去会把花费算错,所以宁可标成算不出,提醒你把汇率填上。

**美元汇率要自己填。** 本扩展不联网,查不了汇率,缺省是 0(没设)。在通用配置的 `worlds.budget-alert.usdToCny` 或「设置」面板里填,比如 1 美元 = 7.1 元就填 7.1。

## 单价表怎么改

单价表只给没有 charges 的记录用。单价单位是**人民币元 / 百万 token**,三个价:

```json
{
  "models": {
    "deepseek-chat": { "input": 2, "cacheHit": 0.2, "output": 3 },
    "deepseek-*":    { "input": 2, "cacheHit": 0.2, "output": 3 }
  }
}
```

- `input`:未命中缓存的输入
- `cacheHit`:命中缓存的输入;不写就按 `input` 算
- `output`:输出,包括推理
- 模型名以 `*` 结尾是前缀匹配。精确名优先,其次是最长的前缀

改法有两种:

1. **面板里改(推荐)**:World 页 →「设置」→ 单价表,直接编辑 JSON 后保存。会另存到部署目录的 `data/budget-alert/pricing.json`,以后升级扩展不会覆盖。点「恢复包里的默认表」删掉这份覆盖
2. 直接编辑 `data/budget-alert/pricing.json`,下一次检查(最多 60 秒)就生效

包里自带的 `src/pricing.json` 只是示例价格,**装好后请按你自己的账单改**。表里没有的模型不会按 0 算,而是列进 `unpriced` 提醒你补价格。

## 告警为什么只响一次

每条告警线是一个两态开关:

- **未触发**:花费越过这条线 → 推一次提醒,变成已触发
- **已触发**:花费继续涨也不再提醒;只有回落到这条线以下才复位,复位之后再越过才会再提醒

花费只会往上涨,所以如果每次检查都对比「是否超过」,超过 80% 之后每 60 秒都会响一次,很快就被当成噪音忽略。按「越过」而不是「高于」来触发,每条线一天正常只响一次。会让它复位的情况只有这些:

- 过了零点,新的一天从 0 开始
- 把日预算调高,比例降到线下
- 把告警线改了

一次检查同时越过多条线(比如从 50% 直接跳到 120%)时,只推最高的那条,其余一并记为已触发,不连发。

触发状态存在 `data/budget-alert/alerts.json`,重启 bot 不会把今天已经响过的线再响一遍。

## 事件

类型 `cortico-world.budget-alert`,origin 为 internal,立即投递(flush)。正文是一句中文提醒,`meta` 带:

```json
{ "level": 0.8, "spent": 16.02, "budget": 20, "ts": "2026-11-02T15:21:00.000+08:00" }
```

## 面板

- **今天**:已花、日预算、还剩(超了就显示超出多少),告警线进度,按模型拆分的调用数、token 和花费,按小时的花费,每 60 秒刷新
- **设置**:日预算、告警线(写百分数,如 `80, 100`)、美元汇率,单价表编辑

日预算和美元汇率也在通用配置里(`worlds.budget-alert.dailyYuan`、`worlds.budget-alert.usdToCny`),改了立即生效。告警线是数组,通用配置表单改不了,所以放在「设置」面板里。

## 开发

```
npm run build       # 打包面板,生成 describe.json
npm run typecheck   # tsc --noEmit
npm run lint        # eslint
npm test            # vitest:计价、告警状态机、增量读、事件只推一次
npm run check       # 以上全部 + 用 cortico 自带的 dry-mount 核对
npm run verify      # 不重新打包,只核对:tsc、eslint、vitest、dry-mount、describe.json 一致
```

检查脚本和测试都在安装包里。从安装包复现:解压或进到装好的包目录,`npm install` 装上 devDependencies,再跑 `npm run verify`。

## 许可

MIT
