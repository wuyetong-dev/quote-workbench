# knowledge/ — 知识库目录（开源版为空）

原始版本这里存放三类数据，均**不随开源仓库分发**，因为它们包含真实企业数据：

| 文件 | 内容 | 为何不开源 |
|---|---|---|
| `enterprise-pricebook.json` | 企业历史报价价库（真实项目的物料明细、单价、金额） | 客户商业机密 |
| `entry-library.json` | 报价条目库（含逐行来源追溯、原始 xlsx 价格） | 客户商业机密 |
| `catalog.json` | 知识源索引（引用甲方内部资料路径） | 含未公开的甲方资料引用 |

## 如何自己生成

程序启动时会检查本目录。缺文件时系统以「空知识库」模式运行：公式引擎、模板导出、
报价单生成等核心功能仍可用，但没有历史报价可参照。

按其数据结构自行构建即可：

```json
// knowledge/enterprise-pricebook.json
{
  "name": "你的价库名称",
  "updatedAt": "2026-01-01",
  "entries": []
}
```

章节结构与字段定义见 `formula_engine.py`、`knowledge.js` 与 `export_config.json`。
