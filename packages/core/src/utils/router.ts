import { get_encoding } from "tiktoken";
import { sessionUsageCache, Usage } from "./cache";
import { readFile } from "fs/promises";
import { opendir, stat } from "fs/promises";
import { join } from "path";
import { CLAUDE_PROJECTS_DIR, HOME_DIR } from "@CCR/shared";
import { LRUCache } from "lru-cache";
import { ConfigService } from "../services/config";
import { TokenizerService } from "../services/tokenizer";
import {
  isGroupReference,
  parseGroupReference,
  parseProviderModel,
} from "../types/llm";
import type { ModelGroup, RouterConfig, RouterScenarioType } from "../types/llm";

// Types from @anthropic-ai/sdk
interface Tool {
  name: string;
  description?: string;
  input_schema: object;
}

interface ContentBlockParam {
  type: string;
  [key: string]: any;
}

interface MessageParam {
  role: string;
  content: string | ContentBlockParam[];
}

interface MessageCreateParamsBase {
  messages?: MessageParam[];
  system?: string | any[];
  tools?: Tool[];
  [key: string]: any;
}

const enc = get_encoding("cl100k_base");

export const calculateTokenCount = (
  messages: MessageParam[],
  system: any,
  tools: Tool[]
) => {
  let tokenCount = 0;
  if (Array.isArray(messages)) {
    messages.forEach((message) => {
      if (typeof message.content === "string") {
        tokenCount += enc.encode(message.content).length;
      } else if (Array.isArray(message.content)) {
        message.content.forEach((contentPart: any) => {
          if (contentPart.type === "text") {
            tokenCount += enc.encode(contentPart.text).length;
          } else if (contentPart.type === "tool_use") {
            tokenCount += enc.encode(JSON.stringify(contentPart.input)).length;
          } else if (contentPart.type === "tool_result") {
            tokenCount += enc.encode(
              typeof contentPart.content === "string"
                ? contentPart.content
                : JSON.stringify(contentPart.content)
            ).length;
          }
        });
      }
    });
  }
  if (typeof system === "string") {
    tokenCount += enc.encode(system).length;
  } else if (Array.isArray(system)) {
    system.forEach((item: any) => {
      if (item.type !== "text") return;
      if (typeof item.text === "string") {
        tokenCount += enc.encode(item.text).length;
      } else if (Array.isArray(item.text)) {
        item.text.forEach((textPart: any) => {
          tokenCount += enc.encode(textPart || "").length;
        });
      }
    });
  }
  if (tools) {
    tools.forEach((tool: Tool) => {
      if (tool.description) {
        tokenCount += enc.encode(tool.name + tool.description).length;
      }
      if (tool.input_schema) {
        tokenCount += enc.encode(JSON.stringify(tool.input_schema)).length;
      }
    });
  }
  return tokenCount;
};

const getProjectSpecificRouter = async (
  req: any,
  configService: ConfigService
) => {
  // Check if there is project-specific configuration
  if (req.sessionId) {
    const project = await searchProjectBySession(req.sessionId);
    if (project) {
      const projectConfigPath = join(HOME_DIR, project, "config.json");
      const sessionConfigPath = join(
        HOME_DIR,
        project,
        `${req.sessionId}.json`
      );

      // First try to read sessionConfig file
      try {
        const sessionConfig = JSON.parse(await readFile(sessionConfigPath, "utf8"));
        if (sessionConfig && sessionConfig.Router) {
          return sessionConfig.Router;
        }
      } catch {}
      try {
        const projectConfig = JSON.parse(await readFile(projectConfigPath, "utf8"));
        if (projectConfig && projectConfig.Router) {
          return projectConfig.Router;
        }
      } catch {}
    }
  }
  return undefined; // Return undefined to use original configuration
};

const getUseModel = async (
  req: any,
  tokenCount: number,
  configService: ConfigService,
  lastUsage?: Usage | undefined
): Promise<{ model: string; scenarioType: RouterScenarioType }> => {
  const projectSpecificRouter = await getProjectSpecificRouter(req, configService);
  const providers = configService.get<any[]>("providers") || configService.get<any[]>("Providers") || [];
  const Router = projectSpecificRouter || configService.get("Router");

  // Detect compact requests by checking for the specific prompt pattern in the last user message
  const COMPACT_PROMPT_MARKER = "create a detailed summary of the conversation";
  if (Array.isArray(req.body.messages)) {
    const lastUserMessage = req.body.messages.findLast((m: any) => m.role === "user");
    if (lastUserMessage) {
      const messageContent = typeof lastUserMessage.content === "string"
        ? lastUserMessage.content
        : (Array.isArray(lastUserMessage.content) ? lastUserMessage.content.map((c: any) => c.text).join(" ") : "");
      if (messageContent.includes(COMPACT_PROMPT_MARKER) && Router?.compact) {
        req.log.info(`Using compact model for summary request`);
        return { model: Router.compact, scenarioType: 'compact' };
      }
    }
  }

  if (parseProviderModel(req.body.model)) {
    return { model: normalizeExplicitProviderModel(req.body.model, providers), scenarioType: 'default' };
  }

  // if tokenCount is greater than the configured threshold, use the long context model
  const longContextThreshold = Router?.longContextThreshold || 60000;
  const lastUsageThreshold =
    lastUsage &&
    lastUsage.input_tokens > longContextThreshold &&
    tokenCount > 20000;
  const tokenCountThreshold = tokenCount > longContextThreshold;
  if ((lastUsageThreshold || tokenCountThreshold) && Router?.longContext) {
    req.log.info(
      `Using long context model due to token count: ${tokenCount}, threshold: ${longContextThreshold}`
    );
    return { model: Router.longContext, scenarioType: 'longContext' };
  }
  const subagentModel = tryResolveSubagentModelFromRequest(req, configService);
  if (subagentModel) {
    return { model: subagentModel, scenarioType: 'default' };
  }
  // Use the background model for any Claude Haiku variant
  const globalRouter = configService.get("Router");
  if (
    req.body.model?.includes("claude") &&
    req.body.model?.includes("haiku") &&
    globalRouter?.background
  ) {
    req.log.info(`Using background model for ${req.body.model}`);
    return { model: globalRouter.background, scenarioType: 'background' };
  }

  if (isImageRequest(req) && Router?.image) {
    req.log.info("Using image model for image request");
    return { model: Router.image, scenarioType: 'image' };
  }

  // The priority of websearch must be higher than thinking.
  if (
    Array.isArray(req.body.tools) &&
    req.body.tools.some((tool: any) => tool.type?.startsWith("web_search")) &&
    Router?.webSearch
  ) {
    return { model: Router.webSearch, scenarioType: 'webSearch' };
  }
  // if exits thinking, use the think model
  if (req.body.thinking && Router?.think) {
    req.log.info(`Using think model for ${req.body.thinking}`);
    return { model: Router.think, scenarioType: 'think' };
  }
  return { model: Router?.default, scenarioType: 'default' };
};

function getTokenizerLookupModel(model: string | undefined, fallbackModel: string): string {
  const candidate = model || fallbackModel;
  if (parseProviderModel(candidate)) {
    return candidate;
  }

  return fallbackModel;
}

export interface RouterContext {
  configService: ConfigService;
  tokenizerService?: TokenizerService;
  event?: any;
}

// Round-robin index for model groups
const groupRotationIndex = new Map<string, number>();

export function resetModelGroupRotationState(): void {
  groupRotationIndex.clear();
}

/**
 * Resolve a model group name to a specific "provider,model" string using round-robin.
 * Returns null if the group is not found or is empty.
 */
function resolveModelGroup(
  groupName: string,
  configService: ConfigService,
  req: any
): string | null {
  const groups = configService.get<ModelGroup[]>("ModelGroups") || [];
  const group = groups.find(g => g.name === groupName);

  if (!group) {
    req.log.error(`ModelGroup '${groupName}' not found`);
    return null;
  }
  if (!group.models || group.models.length === 0) {
    req.log.error(`ModelGroup '${groupName}' has no models`);
    return null;
  }

  const index = groupRotationIndex.get(groupName) || 0;
  const selectedModel = group.models[index % group.models.length];
  groupRotationIndex.set(groupName, index + 1);

  req.log.info(`ModelGroup '${groupName}' selected: ${selectedModel} (index: ${index})`);
  return selectedModel;
}

function resolveRouteModelValue(
  value: string | undefined,
  configService: ConfigService,
  req: any,
  options: {
    fallbackToDefault?: boolean;
    visitedGroups?: Set<string>;
  } = {}
): string | undefined {
  if (!value) {
    return value;
  }

  if (!isGroupReference(value)) {
    return value;
  }

  const groupName = parseGroupReference(value);
  if (!groupName) {
    return value;
  }

  const visitedGroups = options.visitedGroups ?? new Set<string>();
  if (visitedGroups.has(groupName)) {
    req.log.error(`Detected recursive ModelGroup fallback for '${groupName}'`);
    return undefined;
  }
  visitedGroups.add(groupName);

  const resolved = resolveModelGroup(groupName, configService, req);
  if (resolved) {
    return resolved;
  }

  if (!options.fallbackToDefault) {
    return undefined;
  }

  const routerConfig = configService.get<RouterConfig>("Router");
  const defaultRoute = routerConfig?.default;
  if (!defaultRoute || defaultRoute === value) {
    req.log.error(`Cannot resolve ModelGroup '${groupName}' and no valid default model available`);
    return undefined;
  }

  const fallbackResolved = resolveRouteModelValue(defaultRoute, configService, req, {
    fallbackToDefault: false,
    visitedGroups,
  });

  if (fallbackResolved) {
    req.log.warn(`ModelGroup '${groupName}' resolution failed, falling back to default: ${fallbackResolved}`);
  } else {
    req.log.error(`Cannot resolve ModelGroup '${groupName}' and no valid default model available`);
  }

  return fallbackResolved;
}

function extractTaggedSubagentModel(text: string | undefined): string | null {
  if (!text || !text.includes("<CCR-SUBAGENT-MODEL>")) {
    return null;
  }

  const match = text.match(/<CCR-SUBAGENT-MODEL>(.*?)<\/CCR-SUBAGENT-MODEL>/s);
  if (!match || match[1] === "provider,model") {
    return null;
  }

  return match[1];
}

function removeTaggedSubagentModel(text: string, model: string): string {
  return text.replace(`<CCR-SUBAGENT-MODEL>${model}</CCR-SUBAGENT-MODEL>`, "");
}

function resolveTaggedSubagentModel(
  taggedModel: string,
  configService: ConfigService,
  req: any
): string | undefined {
  return resolveRouteModelValue(taggedModel, configService, req, {
    fallbackToDefault: true,
  }) || taggedModel;
}

function normalizeExplicitProviderModel(value: string, providers: any[]): string {
  const parsed = parseProviderModel(value);
  if (!parsed) {
    return value;
  }

  const finalProvider = providers.find(
    (p: any) => p.name.toLowerCase() === parsed.provider.toLowerCase()
  );
  const finalModel = finalProvider?.models?.find(
    (m: any) => typeof m === "string" && m.toLowerCase() === parsed.model.toLowerCase()
  );

  if (finalProvider && finalModel) {
    return `${finalProvider.name},${finalModel}`;
  }

  return value;
}

function isImageRequest(req: any): boolean {
  return Array.isArray(req.body?.messages) && req.body.messages.some((message: any) => {
    if (!Array.isArray(message?.content)) {
      return false;
    }

    return message.content.some((part: any) => part?.type === "image" || part?.type === "image_url");
  });
}

function getFirstUserTextMessageContent(req: any): string {
  const firstUserMsg = req.body?.messages?.find((m: any) => m.role === "user");
  if (!firstUserMsg?.content) {
    return "";
  }

  return typeof firstUserMsg.content === "string"
    ? firstUserMsg.content
    : (Array.isArray(firstUserMsg.content)
        ? firstUserMsg.content.find((c: any) => c.type === "text")?.text || ""
        : "");
}

function tryResolveSubagentModelFromRequest(
  req: any,
  configService: ConfigService
): string | undefined {
  if (
    req.body?.system?.length > 1 &&
    typeof req.body?.system[1]?.text === "string"
  ) {
    const taggedModel = extractTaggedSubagentModel(req.body.system[1].text);
    if (taggedModel) {
      req.body.system[1].text = removeTaggedSubagentModel(req.body.system[1].text, taggedModel);
      const resolved = resolveTaggedSubagentModel(taggedModel, configService, req);
      req.log.info(`[SUBAGENT] Using model from system[1].text: ${resolved}`);
      return resolved;
    }
    if (req.body.system[1].text.includes("<CCR-SUBAGENT-MODEL>provider,model</CCR-SUBAGENT-MODEL>")) {
      req.log.info("[SUBAGENT] Ignoring placeholder 'provider,model' in system[1].text, falling back to regular routing.");
    }
  }

  const firstUserMsg = req.body?.messages?.find((m: any) => m.role === "user");
  const contentText = getFirstUserTextMessageContent(req);
  if (contentText) {
    const taggedModel = extractTaggedSubagentModel(contentText);
    if (taggedModel) {
      if (typeof firstUserMsg.content === "string") {
        firstUserMsg.content = removeTaggedSubagentModel(firstUserMsg.content, taggedModel);
      } else if (Array.isArray(firstUserMsg.content)) {
        const textPart = firstUserMsg.content.find((c: any) => c.type === "text");
        if (textPart) {
          textPart.text = removeTaggedSubagentModel(textPart.text, taggedModel);
        }
      }

      const resolved = resolveTaggedSubagentModel(taggedModel, configService, req);
      req.log.info(`[SUBAGENT] Using model from user message: ${resolved}`);
      return resolved;
    }
    if (contentText.includes("<CCR-SUBAGENT-MODEL>provider,model</CCR-SUBAGENT-MODEL>")) {
      req.log.info("[SUBAGENT] Ignoring placeholder 'provider,model' in user message, falling back to regular routing.");
    }
  }

  return undefined;
}

function finalizeRouteModel(
  model: string | undefined,
  configService: ConfigService,
  req: any,
  options: { fallbackToDefault?: boolean } = {}
): string | undefined {
  return resolveRouteModelValue(model, configService, req, {
    fallbackToDefault: options.fallbackToDefault ?? true,
  }) || model;
}

export const router = async (req: any, _res: any, context: RouterContext) => {  // --- vvv TEMPORARY DEBUGGING CODE vvv ---
  const MAGIC_CODE = "CCR_DEBUG_COMPACT_REQUEST"; // 我们约定的魔法代码

  let shouldLog = false;
  if (req.body && Array.isArray(req.body.messages)) {
    // 查找最后一条用户消息
    // 使用 findLast 来确保找到的是真正的最后一个用户消息
    const lastUserMessage = req.body.messages.findLast((m: any) => m.role === "user");

    if (lastUserMessage && typeof lastUserMessage.content === "string" && lastUserMessage.content.includes(MAGIC_CODE)) {
      shouldLog = true;
      // 移除魔法代码，以免它被发送给真正的模型，污染上下文
      lastUserMessage.content = lastUserMessage.content.replace(MAGIC_CODE, "").trim();
      // 如果移除后消息内容为空，可以考虑删除这条消息，避免发送空消息给模型
      if (!lastUserMessage.content) {
        const index = req.body.messages.lastIndexOf(lastUserMessage);
        if (index > -1) {
          req.body.messages.splice(index, 1);
        }
      }
    }
  }

  if (shouldLog) {
    req.log.info("--- RAW REQUEST BODY (MAGIC CODE DETECTED) ---");
    req.log.info(req.body, "Request Body");
    req.log.info("--- END RAW REQUEST BODY ---");
  }
  // --- ^^^ TEMPORARY DEBUGGING CODE ^^^ ---

  const { configService, event } = context;
  // Parse sessionId from metadata.user_id
  if (req.body.metadata?.user_id) {
    const parts = req.body.metadata.user_id.split("_session_");
    if (parts.length > 1) {
      req.sessionId = parts[1];
    }
  }
  const lastMessageUsage = sessionUsageCache.get(req.sessionId);
  const { messages, system = [], tools }: MessageCreateParamsBase = req.body;
  const rewritePrompt = configService.get("REWRITE_SYSTEM_PROMPT");
  if (
    rewritePrompt &&
    system.length > 1 &&
    system[1]?.text?.includes("<env>")
  ) {
    const prompt = await readFile(rewritePrompt, "utf-8");
    system[1].text = `${prompt}<env>${system[1].text.split("<env>").pop()}`;
  }

  try {
    // Try to get tokenizer config for the current model
    const tokenizerLookupModel = getTokenizerLookupModel(req.body.model, configService.get<RouterConfig>("Router")?.default || req.body.model);
    const parsedTokenizerModel = parseProviderModel(tokenizerLookupModel);
    const tokenizerConfig = parsedTokenizerModel
      ? context.tokenizerService?.getTokenizerConfigForModel(
          parsedTokenizerModel.provider,
          parsedTokenizerModel.model
        )
      : undefined;

    // Use TokenizerService if available, otherwise fall back to legacy method
    let tokenCount: number;

    if (context.tokenizerService) {
      const result = await context.tokenizerService.countTokens(
        {
          messages: messages as MessageParam[],
          system,
          tools: tools as Tool[],
        },
        tokenizerConfig
      );
      tokenCount = result.tokenCount;
    } else {
      // Legacy fallback
      tokenCount = calculateTokenCount(
        messages as MessageParam[],
        system,
        tools as Tool[]
      );
    }

    let model;
    const customRouterPath = configService.get("CUSTOM_ROUTER_PATH");
    if (customRouterPath) {
      try {
        const customRouter = require(customRouterPath);
        req.tokenCount = tokenCount; // Pass token count to custom router
        model = await customRouter(req, configService.getAll(), {
          event,
        });
      } catch (e: any) {
        req.log.error(`failed to load custom router: ${e.message}`);
      }
    }
    if (!model) {
      const result = await getUseModel(req, tokenCount, configService, lastMessageUsage);
      model = result.model;
      req.scenarioType = result.scenarioType;
    } else {
      // Custom router doesn't provide scenario type, default to 'default'
      req.scenarioType = 'default';
    }

    req.body.model = finalizeRouteModel(model, configService, req, { fallbackToDefault: true });
  } catch (error: any) {
    req.log.error(`Error in router middleware: ${error.message}`);
    const routerConfig = configService.get<RouterConfig>("Router");
    req.body.model = finalizeRouteModel(routerConfig?.default, configService, req, { fallbackToDefault: false });
    req.scenarioType = 'default';
  }
  return;
};

// Memory cache for sessionId to project name mapping
// null value indicates previously searched but not found
// Uses LRU cache with max 1000 entries
const sessionProjectCache = new LRUCache<string, string>({
  max: 1000,
});

export const searchProjectBySession = async (
  sessionId: string
): Promise<string | null> => {
  // Check cache first
  if (sessionProjectCache.has(sessionId)) {
    const result = sessionProjectCache.get(sessionId);
    if (!result || result === '') {
      return null;
    }
    return result;
  }

  try {
    const dir = await opendir(CLAUDE_PROJECTS_DIR);
    const folderNames: string[] = [];

    // Collect all folder names
    for await (const dirent of dir) {
      if (dirent.isDirectory()) {
        folderNames.push(dirent.name);
      }
    }

    // Concurrently check each project folder for sessionId.jsonl file
    const checkPromises = folderNames.map(async (folderName) => {
      const sessionFilePath = join(
        CLAUDE_PROJECTS_DIR,
        folderName,
        `${sessionId}.jsonl`
      );
      try {
        const fileStat = await stat(sessionFilePath);
        return fileStat.isFile() ? folderName : null;
      } catch {
        // File does not exist, continue checking next
        return null;
      }
    });

    const results = await Promise.all(checkPromises);

    // Return the first existing project directory name
    for (const result of results) {
      if (result) {
        // Cache the found result
        sessionProjectCache.set(sessionId, result);
        return result;
      }
    }

    // Cache not found result (null value means previously searched but not found)
    sessionProjectCache.set(sessionId, '');
    return null; // No matching project found
  } catch (error) {
    console.error("Error searching for project by session:", error);
    // Cache null result on error to avoid repeated errors
    sessionProjectCache.set(sessionId, '');
    return null;
  }
};
