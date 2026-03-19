#!/usr/bin/env tsx
import { mkdir, writeFile } from "fs/promises";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

type Category = "definition" | "classification" | "method" | "comparison" | "entity" | "other";

type GeneratedQuestion = {
  id: number;
  category: Category;
  question: string;
};

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const OUTPUT_FILE = resolve(SCRIPT_DIR, "generated.questions.zh.json");

const TOPIC_GROUPS: string[][] = [
  [
    "立地质量",
    "立地条件",
    "地位指数",
    "土层厚度",
    "土壤质地",
    "土壤肥力",
    "土壤水分",
    "坡位",
    "坡向",
    "坡度",
    "海拔",
    "排水条件",
    "光照条件",
    "风害风险",
    "冻害风险",
  ],
  [
    "种源",
    "采种",
    "种子处理",
    "催芽",
    "播种",
    "发芽率",
    "苗木质量",
    "苗木分级",
    "容器育苗",
    "裸根育苗",
    "扦插育苗",
    "嫁接育苗",
    "苗期管理",
    "苗圃管理",
    "移栽",
  ],
  [
    "树种选择",
    "造林密度",
    "造林方法",
    "整地",
    "混交林",
    "纯林",
    "防护林",
    "用材林",
    "经济林",
    "人工林",
    "天然林",
    "速生林",
    "乡土树种",
    "目标树种",
    "适地适树",
  ],
  [
    "林分结构",
    "林层结构",
    "复层林",
    "同龄林",
    "异龄林",
    "郁闭度",
    "冠幅",
    "树高",
    "胸径",
    "蓄积量",
    "生长量",
    "生产力",
    "目标树",
    "林窗",
    "林下植被",
  ],
  [
    "抚育间伐",
    "修枝",
    "割灌除草",
    "透光伐",
    "生长伐",
    "卫生伐",
    "间伐强度",
    "间伐时期",
    "间伐方式",
    "冠层调控",
    "密度调控",
    "竞争调控",
    "抚育制度",
    "林下管护",
    "目标树经营",
  ],
  [
    "采伐更新",
    "天然更新",
    "人工更新",
    "皆伐更新",
    "择伐更新",
    "带状更新",
    "萌芽更新",
    "补植",
    "更新质量",
    "更新密度",
    "更新潜力",
    "更新失败",
    "更新成功",
    "轮伐期",
    "采伐制度",
  ],
  [
    "施肥",
    "基肥",
    "追肥",
    "灌溉",
    "喷灌",
    "滴灌",
    "沟灌",
    "排水",
    "土壤改良",
    "覆盖",
    "保墒",
    "水分调控",
    "肥力提升",
    "养分循环",
    "土壤压实",
  ],
  [
    "病虫害防治",
    "森林防火",
    "风折",
    "雪压",
    "干旱胁迫",
    "鼠害",
    "蚜虫危害",
    "蛀干害虫",
    "叶部病害",
    "根部病害",
    "杂草竞争",
    "生物入侵",
    "生态风险",
    "经营风险",
    "逆境响应",
  ],
  [
    "森林经营",
    "经营方案",
    "经营目标",
    "经营周期",
    "经营强度",
    "林分改造",
    "结构调整",
    "生态修复",
    "人工林经营",
    "公益林经营",
    "用材林经营",
    "经济林经营",
    "防护林经营",
    "经营决策",
    "森林认证",
  ],
  [
    "样地调查",
    "森林资源清查",
    "遥感监测",
    "生长模型",
    "地位指数模型",
    "材积表",
    "树高曲线",
    "胸径分布",
    "景观格局",
    "生物多样性",
    "水源涵养",
    "土壤保持",
    "碳汇经营",
    "近自然经营",
    "永续利用",
  ],
];

const TOPICS = TOPIC_GROUPS.flat();

const definitionVariants = [
  (topic: string) => `什么是${topic}？`,
  (topic: string) => `请解释${topic}的含义。`,
  (topic: string) => `${topic}具体指什么？`,
  (topic: string) => `如何理解${topic}？`,
];

const classificationVariants = [
  (topic: string) => `${topic}可以按哪些标准进行分类？`,
  (topic: string) => `${topic}通常可以分成哪些类别？`,
  (topic: string) => `${topic}有哪些常见类型？`,
  (topic: string) => `${topic}一般怎样划分层次或类型？`,
];

const methodVariants = [
  (topic: string) => `如何开展${topic}？`,
  (topic: string) => `在实际工作中，${topic}一般怎么实施？`,
  (topic: string) => `进行${topic}时通常要遵循哪些步骤？`,
  (topic: string) => `有哪些可操作的方法可以完成${topic}？`,
];

const comparisonVariants = [
  (topic: string, contrast: string) => `${topic}与${contrast}有什么区别？`,
  (topic: string, contrast: string) => `在${topic}和${contrast}之间，核心差异是什么？`,
  (topic: string, contrast: string) => `${topic}和${contrast}分别适用于什么情形？`,
  (topic: string, contrast: string) => `如果把${topic}与${contrast}对照，主要分歧在哪里？`,
];

const entityVariants = [
  (topic: string) => `与${topic}研究相关的代表人物有哪些？`,
  (topic: string) => `教材中哪一章/哪一节会讲到${topic}？`,
];

const otherVariants = [
  (topic: string) => `请简述${topic}的主要要点。`,
  (topic: string) => `在实际经营中，${topic}通常要优先关注哪些问题？`,
  (topic: string) => `如果要快速掌握${topic}，最重要的内容是什么？`,
  (topic: string) => `围绕${topic}，学生最容易忽略的环节有哪些？`,
];

function assertUnique(values: string[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      throw new Error(`Duplicate ${label}: ${value}`);
    }
    seen.add(value);
  }
}

function generateQuestions(topics: string[]): GeneratedQuestion[] {
  if (topics.length === 0) {
    throw new Error("No topics provided");
  }

  assertUnique(topics, "topic");

  const questions: GeneratedQuestion[] = [];
  const seenQuestions = new Set<string>();
  let id = 1;

  topics.forEach((topic, index) => {
    const contrast = topics[(index * 7 + 11) % topics.length];

    const items: Array<{ category: Category; question: string }> = [
      { category: "definition", question: definitionVariants[index % definitionVariants.length](topic) },
      { category: "classification", question: classificationVariants[index % classificationVariants.length](topic) },
      { category: "method", question: methodVariants[index % methodVariants.length](topic) },
      { category: "comparison", question: comparisonVariants[index % comparisonVariants.length](topic, contrast) },
      { category: "entity", question: entityVariants[0](topic) },
      { category: "entity", question: entityVariants[1](topic) },
      { category: "other", question: otherVariants[index % otherVariants.length](topic) },
      { category: "other", question: otherVariants[(index + 1) % otherVariants.length](topic) },
    ];

    for (const item of items) {
      const question = item.question.trim();
      if (seenQuestions.has(question)) {
        throw new Error(`Duplicate generated question: ${question}`);
      }
      seenQuestions.add(question);
      questions.push({
        id: id++,
        category: item.category,
        question,
      });
    }
  });

  if (questions.length < 1200) {
    throw new Error(`Generated only ${questions.length} questions`);
  }

  const categories = new Set(questions.map((item) => item.category));
  const requiredCategories: Category[] = [
    "definition",
    "classification",
    "method",
    "comparison",
    "entity",
    "other",
  ];

  for (const category of requiredCategories) {
    if (!categories.has(category)) {
      throw new Error(`Missing required category: ${category}`);
    }
  }

  return questions;
}

async function main(): Promise<void> {
  const questions = generateQuestions(TOPICS);
  await mkdir(dirname(OUTPUT_FILE), { recursive: true });
  await writeFile(OUTPUT_FILE, `${JSON.stringify(questions, null, 2)}\n`, "utf8");
  console.log(`Generated ${questions.length} questions -> ${OUTPUT_FILE}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
