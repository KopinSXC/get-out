# 更新记录

## 0.1.2

- 工作区根缺省改为部署目录下的 `workspace/`;留空才拍整个部署目录。工作区根不存在时拒绝拍快照
- 符号链接测试在 Windows 上改用 junction,没权限(EPERM)时跳过,不再误报失败

## 0.1.1

- 不再拷贝 `.env` / `.env.*`(含密钥),回滚也不碰它们
- `snapshots/` 里别的工具留下的目录不列出、不计入保留上限、不会被删除:只认 manifest 里带 `tool` 标记的快照
- README 删掉了错误的「memory/ 和 data/ 同级」说法
- 安装包里带上 scripts/check-extension.ts、test/、tsconfig.json、eslint.config.js;装好后在包目录里装上 devDependencies,跑 `npm run verify` 即可复现全部检查

## 0.1.0

- 首个版本:snapshot_create / snapshot_list / snapshot_restore / snapshot_delete,快照列表面板,保留策略
