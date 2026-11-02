# 更新记录

## 0.1.1

- 只改打包:安装包里带上检查脚本、测试和 tsconfig / eslint 配置,可以从安装包复现检查
- 安装包里带上 scripts/check-extension.ts、test/、tsconfig.json、eslint.config.js;装好后在包目录里装上 devDependencies,跑 `npm run verify` 即可复现全部检查

## 0.1.0

- 首个版本:ocr_screen / ocr_find,Windows.Media.Ocr 经 PowerShell 桥接,开关配置,「试一下」面板
