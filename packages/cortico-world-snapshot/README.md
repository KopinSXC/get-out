# cortico-world-snapshot

Cortico World 扩展(api 6)。给工作区拍时间点快照,能列、能回滚、能删。

## 装上之后

- 工具:`snapshot_create`、`snapshot_list`、`snapshot_restore`、`snapshot_delete`
- 配置:工作区根、最多保留几份,改了立即生效
- 面板「快照列表」:最近 20 份,每行 id、时间、大小、文件数,带「回滚」「删除」,两个按钮都要再确认一次

## 工作区根与目录布局

工作区根默认是部署目录(`config.json`、`data/`、`memory/` 所在的那一层),可以在配置里改成别的目录;相对路径按部署目录解析。

```
<工作区根>/snapshots/
  20261102-093015/
    manifest.json      {id, createdAt, note, fileCount, totalBytes, sourceRoot, skipped[], complete, files[]}
    files/…            工作区文件的完整拷贝,保持原相对路径
  20261102-093015-2/   同一秒拍了第二份,加序号,不覆盖
  pre-restore-20261102-101200/   回滚前的自动备份
```

`manifest.json` 在拷贝之前先写一次(`complete: false`),全部拷完再补上实际统计并置 `complete: true`。拍到一半出错会把这份半成品整个删掉;如果进程在中途被杀,留下的目录在列表里标「不完整」,不能拿来回滚。

## 跳过规则

| 情况 | 处理 |
|---|---|
| `<工作区根>/snapshots/` 整个目录 | 按**绝对路径**排除,不进快照,也不出现在 skipped 里 |
| 名为 `node_modules`、`.git` 的目录或文件 | 跳过,记进 skipped |
| 名字以 `tmp-` 开头的目录或文件 | 跳过,记进 skipped |
| 单文件超过 100MB | 跳过,记进 skipped(带字节数) |
| `archive/` 下单文件超过 50MB | 跳过,记进 skipped(带字节数) |
| 符号链接 | 不跟随,记进 skipped |
| 读不了的文件或目录 | 跳过,记进 skipped(带错误原因) |

快照目录为什么按绝对路径判:它本身就在工作区里面。如果按名字 `snapshots` 判,工作区里别处同名的目录会被误跳;如果不排除,每份新快照都会把之前所有快照再拷一遍,体积按份数滚雪球。所以只认 `<工作区根>/snapshots` 这一个绝对路径,别处叫 `snapshots` 的目录照常拷。

## 回滚为什么先备份

回滚会覆盖和删除工作区里的文件。如果回错了快照,或者回完才发现最近的改动还有用,没有备份就找不回来。所以 `snapshot_restore` 的第一步总是把当前状态完整拍成 `pre-restore-<时间戳>`,备份成功后才动工作区;备份失败就整个中止,工作区一个文件都不碰。想撤销这次回滚,再回滚到那份 `pre-restore-*` 即可。

回滚的具体动作是逐个文件处理,从不整目录删除:

- 快照里有、工作区里没有:补上
- 两边都有、内容不同(先比大小,再比 SHA-256):覆盖
- 两边都有、内容相同:不动
- 工作区里有、快照里没有:删除这个文件。只删快照当时也会拍进去的文件;`node_modules`、`.git`、`tmp-*`、超限文件和快照 skipped 里列出的路径都不碰
- 删完文件留下的空目录保留

动手之前先校验快照里的每个路径:绝对路径、含 `..` 段、解析后跳出工作区或落进 `snapshots/` 的,整次回滚直接拒绝。写入和删除前还会对父目录取 realpath,防止工作区里的符号链接把写操作带到根外或快照目录里;这类文件记进回执的 `errors`,其余文件照常处理。

回滚会改 `data/`、`memory/`、`config.json` 这些 bot 正在用的文件,**回滚完建议重启 bot**,否则进程里缓存的状态可能把旧内容再写回去。

## 保留策略

- 普通快照默认最多 30 份(配置里可改),每拍一份新的就检查一次,超出的从最旧的开始删
- `pre-restore-*` 不计入上限,永远不会被自动删除;不需要时用 `snapshot_delete` 或面板手动删
- `snapshot_list` 和面板只显示最近 20 份,磁盘上可能还有更早的

## 其他

- 所有操作串行执行,拍快照和回滚不会交错
- 只用 `fs/promises`;不联网
- `snapshot_delete` 删除整个快照目录,不可恢复

## 开发

```
npm run build       # 打包面板,生成 describe.json
npm run typecheck   # tsc --noEmit
npm run lint        # eslint
npm test            # vitest,全部在临时目录里的假工作区上跑
npm run check       # 以上全部 + 用 cortico 自带的 dry-mount 核对
```

## 许可

MIT
