# 报价工作台 · Quote Workbench

一个**面向非标设备制造**的报价工作台：把「陌生的工程资料」变成「可交付的最终报价」。
Python 后端 + 原生 JS 前端，本地运行、离线可用、单机便携。

> ⚠️ **关于本仓库的范围**
> 这是一个**代码开源、数据不开源**的项目。原始的客户价库、合同模板、企业抬头信息
> 已全部剥离，详见下文[「关于剥离的企业数据」](#关于剥离的企业数据)。

## 它能做什么

非标设备（电镀线、清洗线、自动化产线……）的报价难点不在算数，在于**同一份图纸，两个人报出两个价**。
这个工作台解决的是这个问题——把报价拆成可复算的结构：

| 环节 | 能力 |
|---|---|
| **资料导入** | 读 Excel / PDF / 文档，抽取设备清单与参数 |
| **结构化拆解** | 把一坨文本拆成「设备项 / 补充信息 / 条件要求 / 甲方自备」四类，识别哪些该收费 |
| **公式引擎** | 槽体、管路、铜排、骨架的物理量计算 → 成本 → 报价，每步可追溯 |
| **价格来源审计** | 每个数字标注来源：原表单价 / 公式推算 / 人工覆盖，可反查单元格 |
| **多方案对比** | 同项目不同配置并排比价，差异定位到行 |
| **导出** | Excel 报价单、PDF 合同、商务报价书，模板可配 |
| **历史学习** | 从过往报价里学规则，下次遇到同类结构自动建议 |

## 快速开始

```bash
# 纯标准库，无需 pip install
python server.py
```

浏览器打开终端里打印的地址（默认 <http://127.0.0.1:19904>）。

需要 Python 3.9+。`requirements.txt` 中的依赖仅 PDF/Excel 导出需要，核心逻辑不依赖第三方库。

## 架构

```
quote-workbench/
├── server.py                 # HTTP 服务 + 路由
├── formula_engine.py         # 公式引擎：物理量 → 成本 → 报价
├── calculation_engine.py     # 计算调度
├── decomposition.py          # 资料拆解：文本 → 结构化设备清单
├── parameter_parser.py       # 参数抽取（尺寸/材质/数量）
├── quote_entry.py            # 报价条目管理
├── quotation_document.py     # 报价单文档模型
├── quotation_validation.py   # 报价校验（漏项/超限/矛盾）
├── source_audit.py           # 价格来源审计
├── history_learning.py       # 历史报价规则学习
├── export_layout.py          # 导出模板布局
├── export_templates.py       # 导出模板
├── business_export.py        # 商务报价书导出
├── pdf_export.py             # PDF 导出
├── reference_excel.py        # Excel 参考表处理
├── knowledge/                # 知识库（开源版为空，见该目录 README）
├── web/                      # 前端（原生 JS，无框架、无构建）
│   ├── index.html
│   ├── app.js                # 主应用
│   ├── model.js              # 数据模型
│   ├── formulas.js           # 前端公式镜像
│   ├── decomposition.js      # 拆解界面
│   ├── calculation-ui.js     # 计算界面
│   ├── export-*.js           # 导出界面
│   └── assets/               # 模板与配置（开源版已清理）
└── tools/                    # 辅助脚本
```

## 核心设计思想

**每个数字都要能回答「你凭什么这么报」。**

所以价格不是算完就完，而是带溯源链：`这个 17800 是从哪张表哪个单元格来的`
`这个系数是公式推的还是人工改的`。`source_audit.py` 和 `source-facts.js` 就是干这个的。

代价是数据结构比普通报价表重得多——但也正因为重，报价才经得起甲方追问和事后复盘。

## 关于剥离的企业数据

本仓库**只开源技术与方法论**：算法、数据结构、拆解逻辑、公式引擎、导出机制。
一切属于某家具体企业的东西都不在这里。

以下内容**有意不包含**在本仓库中：

| 剥离项 | 说明 |
|---|---|
| `knowledge/enterprise-pricebook.json` | 企业历史报价价库（物料明细、单价、金额） |
| `knowledge/entry-library.json` | 报价条目库（含逐行 xlsx 来源追溯） |
| `knowledge/catalog.json` | 知识源索引（含内部资料路径） |
| `web/assets/customer-templates/` | 客户合同抬头/页脚图与列宽配置 |
| `web/assets/export-layout.json` 中的企业信息 | 公司名/地址/电话/开户行账号 → 占位符 |
| `web/assets/export-layout.json` 中的商务条款 | 定价政策、账期、交货范围等 → 空数组 |
| `web/assets/fixed-header.png` | 公司抬头图（含 LOGO 与联系方式） |
| `data/workbench.sqlite3` | 运行时业务数据库 |

剥离后系统仍可完整启动，以「空知识库」模式运行：公式引擎、拆解、导出等核心功能全部可用，
只是没有历史报价可参照。如何自行构建价库见 `knowledge/README.md`。

## 许可

本项目代码以 MIT 发布（见 `LICENSE`）。
