# cortico-world-ocr

Cortico World 扩展(api 6)。用 Windows 自带的 OCR 把屏幕上的文字读成带坐标的纯文本,不调视觉模型、不发图片,用来省 token。

只支持 Windows 10 / 11。其他平台上能装、能挂载,工具会直接回 `{ok:false, reason}`。

## 工具

**`ocr_screen {region?, scale?}`**:读屏幕文字。回执是一行一条:

```
OCR 前台窗口所在显示器 0,0 2560x1440,识别图 1600x900,语言 zh-Hans-CN,3 行
坐标 x,y,w,h 是屏幕原始像素
24,12,180,22  文件  编辑  查看  帮助
24,64,640,28  正在保存 report.docx
1180,1360,96,30  确定
```

- 不给 `region`:按配置截前台窗口所在的整块显示器,或只截前台窗口
- `region {x,y,w,h}`:只截这一块,屏幕原始像素,多显示器时可以是负数
- `scale`:识别前的缩放倍数(0.25 到 4),小字可以给 2;不给就用面板里的默认值

**`ocr_find {pattern}`**:在屏幕文字里找一段字,返回每处的外框和中心点,用来找按钮在哪。`pattern` 按不区分大小写的正则匹配,写错了的正则当普通文字找。

```
查找 "确定":1 处(坐标 x,y,w,h 与中心点都是屏幕原始像素)
1. 1180,1360,96,30 中心 1228,1375  确定
```

## 怎么做的

1. Node 用 `child_process` 调 `powershell.exe -File src/ocr.ps1`,参数以 base64 JSON 传过去
2. 脚本先声明每显示器 DPI 感知,所以坐标都是物理像素
3. 找前台窗口和它所在的显示器,用 GDI+ 截屏,截图只在内存里
4. 用 System.Drawing 高质量双三次插值缩放到长边不超过 1600(再乘上 `scale`,但不超过 1600)
5. 内存流交给 `Windows.Graphics.Imaging.BitmapDecoder`,再交给 `Windows.Media.Ocr.OcrEngine`
6. 脚本回传每个文本块 `{text, x, y, w, h, line}`(识别图坐标),Node 换算回屏幕原始像素,再合并成行

合并规则:先按 Windows 给的行把词拼起来,汉字、假名之间不加空格,英文单词之间加一个空格;再把高度重叠过半、左右不重叠的段并成同一行,中间隔得远(超过 1.5 倍字高)的用两个空格分开,当作分栏。空碎片和空行丢掉。回执超过 8000 字就停在整行处,末尾写明一共多少行、显示到第几行。

## 隐私

- 截图、缩放后的图都只在 PowerShell 进程的内存里,用完即释放,不写临时文件
- 工具回执只有文字和坐标,不带图片
- 面板里有「允许 OCR」总开关,关掉后两个工具直接拒绝,不会截屏
- 不联网,不下载任何模型

`Add-Type` 编译那段 P/Invoke 声明时,Windows PowerShell 会在 `%TEMP%` 里生成临时程序集,这是编译产物,和截图无关。

## 依赖与降级

不依赖 tesseract,不依赖任何 npm 运行时包。

- 识别:系统自带的 `Windows.Media.Ocr`,语言跟随系统。要识别中文,系统里得装了中文语言并带「光学字符识别」组件(设置 → 时间和语言 → 语言)。也可以在配置里固定 `zh-Hans-CN`、`en-US` 这类标签
- 缩放:用 Windows PowerShell 自带的 System.Drawing,所以**没有用 sharp**。规格允许把 sharp 作为可选依赖做缩放和二值化,但截图已经在 PowerShell 进程里,再搬到 Node 交给 sharp 处理要多一次进程间传输,还要多装一个原生模块;System.Drawing 足够做缩放
- 二值化:不做。Windows.Media.Ocr 内部会自己处理对比度,对正常的界面文字效果够用。遇到浅色底浅色字、半透明叠层这类情况识别不好时,降级办法是:用 `region` 只截那一块,把 `scale` 调到 2 到 3 再识别;还不行就换视觉模型
- 必须是 Windows PowerShell 5.1(`powershell.exe`,系统自带)。PowerShell 7(`pwsh`)加载不了 WinRT 类型,脚本会直接报错

## 它读不到什么

OCR 只认文字。下面这些它都给不了:

- 图标、按钮上的图形、没有文字的工具栏
- 颜色:哪个是红色警告、哪个按钮高亮、主题深浅
- 界面状态:复选框勾没勾、开关开没开、单选选中哪个、按钮是不是灰的、哪个标签页是当前页、输入框里光标在哪
- 布局关系:哪个文字属于哪个控件、弹窗挡住了什么、元素的层级
- 图片、图表、视频画面里的内容(图里恰好有清晰文字的除外)
- 很小、很糊、艺术字、竖排、旋转的文字,识别率会明显下降
- 被其他窗口挡住的部分,以及锁屏、UAC 这类安全桌面

## 什么时候该换视觉模型

- 要判断状态而不是读字:「这个开关开了吗」「哪一项被选中了」「有没有报错的红框」
- 要找的是图标或没有文字的按钮
- 要理解图片、图表、游戏画面
- OCR 结果乱码多、连续几次调 `scale` 和 `region` 都读不对
- 需要知道元素之间的空间关系,而行坐标不够用

一个省 token 的组合:先用 `ocr_find` 定位到大致区域,读不出来的时候再只把那一小块交给视觉模型。

## 配置

| 字段 | 缺省 | 说明 |
|---|---|---|
| `worlds.ocr.allow` | `true` | 允许 OCR 总开关 |
| `worlds.ocr.defaultScale` | `1` | 工具没给 scale 时用的倍数 |
| `worlds.ocr.foregroundOnly` | `false` | 只截前台窗口;关着时截前台窗口所在显示器 |
| `worlds.ocr.language` | 空 | OCR 语言标签,空 = 跟随系统 |
| `worlds.ocr.timeoutSec` | `20` | 单次识别超时 |

都在 World 页的配置里,改了立即生效。另有一个「试一下」面板,点一下识别当前屏幕,显示模型会收到的原文。

## 性能

每次调用都会新起一个 PowerShell 进程,加载 WinRT 和编译 P/Invoke 声明,一次大约 1 到 3 秒,视机器而定。同一时刻只跑一个识别,多个调用会排队。

## 开发

```
npm run build       # 打包面板,生成 describe.json
npm run typecheck   # tsc --noEmit
npm run lint        # eslint
npm test            # vitest:坐标换算、合并、查找、截断,以及 ocr.ps1 带 BOM
npm run check       # 以上全部 + 用 cortico 自带的 dry-mount 核对
npm run verify      # 不重新打包,只核对:tsc、eslint、vitest、dry-mount、describe.json 一致
```

检查脚本和测试都在安装包里。从安装包复现:解压或进到装好的包目录,`npm install` 装上 devDependencies,再跑 `npm run verify`。

`src/ocr.ps1` 必须保存为带 BOM 的 UTF-8:Windows PowerShell 5.1 会把不带 BOM 的脚本按系统 ANSI 代码页读,里面的中文提示会乱码。测试会检查这一点。

## 许可

MIT
