# 更新记录

## 0.1.1

- 计费改为:记录里有 provider 实扣的 charges 就按它算(美元按配置的汇率折人民币),没有才回落到单价表;charges 有但没设汇率时标为算不出,不回落
- 新配置 `usdToCny`(美元汇率),缺省 0 = 没设
- 读数增加 `basis`(各计费来源的调用数)和每个模型的 `reasons`
- 安装包里带上 scripts/check-extension.ts、test/、tsconfig.json、eslint.config.js;装好后在包目录里装上 devDependencies,跑 `npm run verify` 即可复现全部检查

## 0.1.0

- 首个版本:budget_status / budget_set,cortico-world.budget-alert 事件(每条线只响一次),今天读数与设置两个面板,可改的单价表
