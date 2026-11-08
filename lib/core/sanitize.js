import { normalizeText } from './util.js';
import { languageOf } from './tokenize.js';

/**
 * Patterns that indicate an attempt to turn historical data into instructions.
 * They are intentionally conservative: a false positive quarantines a snippet
 * from the model context, which is safer than following an injected command.
 */
const HIGH_PATTERNS = [
  { id: 'ignore-instructions', re: /(?:ignore|disregard|forget|override)\s+(?:all\s+)?(?:previous|prior|above|earlier|system)\s+(?:instructions?|prompts?|rules?)/gi },
  { id: 'ignore-instructions-zh', re: /(?:忽略|无视|忘记|覆盖|绕过)\s*(?:之前|以上|前面|所有|全部|系统|开发者)?\s*(?:的)?\s*(?:指令|提示词|提示|规则|约束)/g },
  { id: 'role-hijack', re: /(?:you\s+are\s+now|from\s+now\s+on\s+you\s+are|act\s+as\s+(?:the\s+)?system|jailbreak|developer\s+mode)/gi },
  { id: 'role-hijack-zh', re: /(?:你现在是|从现在开始你是|进入开发者模式|越狱模式|扮演系统)/g },
  { id: 'prompt-exfiltration', re: /(?:reveal|print|show|repeat|leak)\s+(?:your\s+)?(?:hidden\s+)?(?:system\s+prompt|developer\s+message|instructions)/gi },
  { id: 'prompt-exfiltration-zh', re: /(?:输出|打印|泄露|告诉我|显示)\s*(?:你的|系统)?\s*(?:系统提示词|隐藏指令|开发者消息|完整提示)/g },
  { id: 'exfiltration', re: /(?:send|upload|post|forward|share|exfiltrate)\s+(?:all|every|the)\s+(?:data|files?|conversations?|memories|secrets?|tokens?)/gi },
  { id: 'exfiltration-zh', re: /(?:把|将)\s*(?:所有|全部|其他工作区|其它工作区|全部工作区).{0,18}(?:资料|数据|对话|记忆|文件|内容).{0,12}(?:发送|上传|传给我|发给我|分享|外传)/g },
  { id: 'permission-bypass', re: /(?:bypass|circumvent|skip|disable)\s+(?:the\s+)?(?:permission|authorization|auth|access\s+control|sandbox|approval)/gi },
  { id: 'permission-bypass-zh', re: /(?:绕过|跳过|关闭|取消|禁用)\s*(?:权限|授权|鉴权|安全|沙箱|审批|访问控制)/g },
  { id: 'destructive', re: /(?:delete|erase|wipe|destroy|clear)\s+(?:all\s+)?(?:memories|indexes?|index|audit|logs?|vault|data)/gi },
  { id: 'destructive-zh', re: /(?:删除|清空|销毁|抹掉)\s*(?:所有|全部)?\s*(?:记忆|索引|审计|日志|保险库|数据)/g },
  { id: 'tool-syntax', re: /(?:<\|?(?:tool|system|assistant|user)\|?>|\[(?:tool|system|INST)\]|"tool_calls"\s*:|<system>|<\/system>)/gi },
  { id: 'role-tag', re: /^\s*#{2,}\s*(?:system|developer|assistant)\s*:/gim },
  { id: 'hide-from-user', re: /(?:do\s+not|don't|never)\s+(?:tell|inform|notify|warn)\s+(?:the\s+)?user/gi },
  { id: 'hide-from-user-zh', re: /(?:不要|别|不得)\s*(?:告诉|通知|提醒|告知)\s*(?:用户|使用者)/g },
  { id: 'shell-command', re: /(?:curl|wget|invoke-webrequest|powershell(?:\.exe)?|rm\s+-rf|format\s+[a-z]:)/gi },
  { id: 'approval-impersonation', re: /(?:the\s+)?user\s+(?:has\s+)?(?:already\s+)?(?:approved|authorized|granted\s+permission)/gi },
];

const MEDIUM_PATTERNS = [
  { id: 'system-prompt', re: /(?:system\s+prompt|developer\s+message|hidden\s+instructions?|系统提示词|开发者消息|隐藏指令)/gi },
  { id: 'instruction-word', re: /(?:instructions?|directives?|指令|命令|提示词)/gi },
  { id: 'override', re: /(?:override|supersede|replace\s+the\s+system|覆盖系统|替换系统)/gi },
  { id: 'tool-call', re: /(?:call\s+the\s+tool|invoke\s+the\s+tool|调用工具|调用接口|执行命令)/gi },
  { id: 'base64', re: /(?:base64|rot13|hex\s+decode)/gi },
];

const SECRET_PATTERNS = [
  { id: 'pem-private-key', re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g, replacement: '[REDACTED_PRIVATE_KEY]' },
  { id: 'deepseek-key', re: /\bsk-[A-Za-z0-9_-]{20,}\b/g, replacement: '[REDACTED_API_KEY]' },
  { id: 'openai-key', re: /\bsk-proj-[A-Za-z0-9_-]{20,}\b/g, replacement: '[REDACTED_API_KEY]' },
  { id: 'aws-key', re: /\bAKIA[0-9A-Z]{16}\b/g, replacement: '[REDACTED_AWS_KEY]' },
  { id: 'github-token', re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g, replacement: '[REDACTED_GITHUB_TOKEN]' },
  { id: 'slack-token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, replacement: '[REDACTED_SLACK_TOKEN]' },
  { id: 'bearer', re: /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, replacement: 'Bearer [REDACTED_TOKEN]' },
  { id: 'password-assignment', re: /\b(password|passwd|pwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token)\s*[:=]\s*["']?([^\s"',;]{6,})/gi, replacement: (_m, key) => `${key}=[REDACTED_SECRET]` },
];

/** Remove control/format characters that can hide content or reorder text. */
export function stripUnsafeUnicode(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/[\u202A-\u202E\u2066-\u2069\u200B-\u200F\uFEFF]/g, '')
    .replace(/\uFFFD/g, '');
}

/** Redact well-known credential shapes before storage. */
export function redactSecrets(value) {
  let text = stripUnsafeUnicode(value);
  const found = [];
  for (const pattern of SECRET_PATTERNS) {
    let matched = false;
    text = text.replace(pattern.re, (...args) => {
      matched = true;
      const replacement = typeof pattern.replacement === 'function'
        ? pattern.replacement(...args)
        : pattern.replacement;
      return replacement;
    });
    if (matched) found.push(pattern.id);
  }
  return { text, redactions: found };
}

/** Detect prompt-injection and data-exfiltration attempts. */
export function detectInjection(value) {
  const text = stripUnsafeUnicode(value);
  const high = [];
  const medium = [];
  for (const pattern of HIGH_PATTERNS) {
    pattern.re.lastIndex = 0;
    if (pattern.re.test(text)) high.push(pattern.id);
  }
  for (const pattern of MEDIUM_PATTERNS) {
    pattern.re.lastIndex = 0;
    if (pattern.re.test(text)) medium.push(pattern.id);
  }
  const risk = high.length > 0 || medium.length >= 3 ? 'high' : medium.length > 0 ? 'medium' : 'low';
  return { risk, high, medium };
}

/** Normalize, redact, and classify one imported text segment. */
export function analyzeText(value) {
  const normalized = normalizeText(value);
  const { text, redactions } = redactSecrets(normalized);
  const injection = detectInjection(text);
  return {
    text,
    redactions,
    injection,
    risk: injection.risk,
    language: languageOf(text),
  };
}

/**
 * Escape untrusted text for a model-facing XML-like reference block.
 * All angle brackets are escaped so content cannot close the wrapper.
 */
export function escapeForReference(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Turn high-risk instruction phrases into inert, visible markers for human review. */
export function neutralizeForHuman(value) {
  let text = stripUnsafeUnicode(value);
  for (const pattern of HIGH_PATTERNS) {
    pattern.re.lastIndex = 0;
    text = text.replace(pattern.re, '[已隔离的可疑指令]');
  }
  return text;
}

/** A compact, explicit warning for risky snippets. */
export function riskLabel(risk) {
  if (risk === 'high') return '高风险：已从 AI 上下文隔离';
  if (risk === 'medium') return '中风险：仅作不可信参考';
  return '低风险';
}
