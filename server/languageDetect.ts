/**
 * 检测文本语言
 * 返回 'zh' | 'en'
 */
export function detectLanguage(text: string): "zh" | "en" {
  const chineseChars = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  const totalChars = text.replace(/\s/g, "").length;
  if (totalChars === 0) return "zh";
  return chineseChars / totalChars > 0.15 ? "zh" : "en";
}

/**
 * 检测文档语言（用于 PDF/Word 处理时自动标记教材语言）
 * 取前 2000 字符样本
 */
export function detectDocumentLanguage(text: string): "zh" | "en" {
  return detectLanguage(text.substring(0, 2000));
}
