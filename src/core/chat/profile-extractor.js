/**
 * Profile Extractor — Infers user traits from conversation behavior.
 *
 * This runs on every turn and produces observations for the ProfileStore.
 * It looks at WHAT the user says, HOW they say it, and WHEN they say it.
 */

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function extractProfileObservations({ userText, assistantText, timestamp, messageCount }) {
  const text = normalizeText(userText);
  const lower = text.toLowerCase();
  if (!text || text.length < 2) return [];

  const observations = [];
  const ts = timestamp || new Date().toISOString();

  // === COMMUNICATION STYLE ===
  // Message length tendency
  if (text.length < 15) {
    observations.push({ dimension: "communication", trait: "brief messenger", evidence: text, confidence: 0.12 });
  } else if (text.length > 200) {
    observations.push({ dimension: "communication", trait: "detailed communicator", evidence: text.slice(0, 80), confidence: 0.12 });
  }

  // Emoji usage
  const emojiCount = (text.match(/[\u{1F600}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu) || []).length;
  if (emojiCount >= 2) {
    observations.push({ dimension: "communication", trait: "loves emoji", evidence: text.slice(0, 60), confidence: 0.15 });
  }

  // Direct vs soft tone
  if (/(帮我|直接|快|赶紧|马上|立刻)/.test(text)) {
    observations.push({ dimension: "communication", trait: "direct and action-oriented", evidence: text.slice(0, 60), confidence: 0.12 });
  }
  if (/(能不能|可以吗|方便吗|麻烦|请|谢谢|感谢)/.test(text)) {
    observations.push({ dimension: "communication", trait: "polite and considerate", evidence: text.slice(0, 60), confidence: 0.1 });
  }

  // === PERSONALITY ===
  // Perfectionism signals
  if (/(还不够好|再改一下|细节|完善|优化|不太满意|差一点|精细)/.test(text)) {
    observations.push({ dimension: "personality", trait: "perfectionist tendency", evidence: text.slice(0, 80), confidence: 0.15 });
  }

  // Experimental / curious
  if (/(试试|好奇|有意思|探索|能不能|新方式|创意|好玩)/.test(text)) {
    observations.push({ dimension: "personality", trait: "curious and experimental", evidence: text.slice(0, 80), confidence: 0.12 });
  }

  // Decisive
  if (/(就这样|定了|直接|不纠结|就用这个|搞定)/.test(text)) {
    observations.push({ dimension: "personality", trait: "decisive", evidence: text.slice(0, 60), confidence: 0.12 });
  }

  // === VALUES ===
  if (/(效率|快速|省时间|别浪费时间|赶紧)/.test(text)) {
    observations.push({ dimension: "values", trait: "values efficiency", evidence: text.slice(0, 60), confidence: 0.15 });
  }
  if (/(好看|美观|设计|审美|UI|颜值|漂亮)/.test(text)) {
    observations.push({ dimension: "values", trait: "values aesthetics", evidence: text.slice(0, 60), confidence: 0.15 });
  }
  if (/(质量|靠谱|稳定|可靠|安全|不能出错)/.test(text)) {
    observations.push({ dimension: "values", trait: "values reliability", evidence: text.slice(0, 60), confidence: 0.12 });
  }
  if (/(创新|创意|不同|独特|与众不同|新鲜)/.test(text)) {
    observations.push({ dimension: "values", trait: "values creativity", evidence: text.slice(0, 60), confidence: 0.12 });
  }

  // === WORK STYLE ===
  const hour = new Date(ts).getHours();
  if (hour >= 0 && hour < 5) {
    observations.push({ dimension: "workStyle", trait: "night owl", evidence: `active at ${hour}:00`, confidence: 0.18 });
  } else if (hour >= 5 && hour < 7) {
    observations.push({ dimension: "workStyle", trait: "early riser", evidence: `active at ${hour}:00`, confidence: 0.15 });
  }

  if (/(计划|规划|安排|清单|列表|todo|步骤|流程)/.test(text)) {
    observations.push({ dimension: "workStyle", trait: "planner", evidence: text.slice(0, 60), confidence: 0.12 });
  }
  if (/(边做边想|先干了再说|直接开始|不想规划|先搞起来)/.test(text)) {
    observations.push({ dimension: "workStyle", trait: "action-first doer", evidence: text.slice(0, 60), confidence: 0.15 });
  }
  if (/(一起|并行|同时|多线程|同时做)/.test(text)) {
    observations.push({ dimension: "workStyle", trait: "multitasker", evidence: text.slice(0, 60), confidence: 0.1 });
  }

  // === EMOTIONAL PATTERNS ===
  if (/(烦|焦虑|压力大|崩溃|累|难受|郁闷|扛不住)/.test(text)) {
    observations.push({ dimension: "emotionalPatterns", trait: "currently stressed", evidence: text.slice(0, 80), confidence: 0.2 });
  }
  if (/(开心|爽|太好了|哈哈|不错|舒服|满意|棒)/.test(text)) {
    observations.push({ dimension: "emotionalPatterns", trait: "positive mood", evidence: text.slice(0, 60), confidence: 0.12 });
  }
  if (/(纠结|犹豫|不确定|不知道选|两难|选择困难)/.test(text)) {
    observations.push({ dimension: "emotionalPatterns", trait: "prone to indecision under pressure", evidence: text.slice(0, 80), confidence: 0.15 });
  }

  // === INTERESTS ===
  if (/(代码|编程|开发|程序|技术|GitHub|API|SDK|框架|前端|后端|全栈)/i.test(text)) {
    observations.push({ dimension: "interests", trait: "software development", evidence: text.slice(0, 60), confidence: 0.15 });
  }
  if (/(设计|UI|UX|figma|sketch|原型|交互|视觉)/i.test(text)) {
    observations.push({ dimension: "interests", trait: "design", evidence: text.slice(0, 60), confidence: 0.15 });
  }
  if (/(创业|产品|商业|融资|市场|用户增长|MVP|商业模式)/i.test(text)) {
    observations.push({ dimension: "interests", trait: "entrepreneurship", evidence: text.slice(0, 60), confidence: 0.15 });
  }
  if (/(音乐|歌|听歌|播放|乐队|concert|spotify)/i.test(text)) {
    observations.push({ dimension: "interests", trait: "music", evidence: text.slice(0, 60), confidence: 0.12 });
  }
  if (/(电影|剧|动漫|看了|追剧|影评|导演)/i.test(text)) {
    observations.push({ dimension: "interests", trait: "film & shows", evidence: text.slice(0, 60), confidence: 0.12 });
  }
  if (/(健身|跑步|运动|锻炼|gym|workout|球|游泳)/i.test(text)) {
    observations.push({ dimension: "interests", trait: "fitness", evidence: text.slice(0, 60), confidence: 0.12 });
  }
  if (/(AI|人工智能|大模型|LLM|机器学习|deep learning|GPT|Claude)/i.test(text)) {
    observations.push({ dimension: "interests", trait: "AI & machine learning", evidence: text.slice(0, 60), confidence: 0.15 });
  }

  // === LIFE CONTEXT ===
  if (/(上班|公司|同事|老板|加班|工作日|周末)/.test(text)) {
    observations.push({ dimension: "lifeContext", trait: "office worker", evidence: text.slice(0, 60), confidence: 0.1 });
  }
  if (/(创业|自己做|独立开发|个人项目|solo|indie)/.test(text)) {
    observations.push({ dimension: "lifeContext", trait: "indie builder / entrepreneur", evidence: text.slice(0, 60), confidence: 0.15 });
  }
  if (/(学生|作业|课|考试|学校|大学|研究生|毕业)/.test(text)) {
    observations.push({ dimension: "lifeContext", trait: "student", evidence: text.slice(0, 60), confidence: 0.15 });
  }

  // Explicit self-description (high confidence)
  const selfMatch = text.match(/我(?:是个?|算是|属于)\s*([^，。！？!?,]{2,20})/);
  if (selfMatch) {
    const desc = selfMatch[1].trim();
    if (desc.length >= 2 && desc.length <= 20) {
      observations.push({ dimension: "personality", trait: desc, evidence: text.slice(0, 80), confidence: 0.55 });
    }
  }

  return observations;
}

module.exports = { extractProfileObservations };
