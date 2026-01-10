/**
 * Bohe-Gemini Transformer
 * 
 * 这个 transformer 专门用于过滤 Gemini API 不支持的 JSON Schema 字段
 * 主要解决 propertyNames 等字段导致 400 错误的问题
 */

module.exports = class BoheGeminiTransformer {
  static TransformerName = "bohe-gemini";

  constructor(options = {}) {
    this.name = 'bohe-gemini';
    // Gemini API 不支持的 JSON Schema 字段列表
    this.unsupportedFields = options.unsupportedFields || [
      'propertyNames',  // JSON Schema 的属性名称验证字段，Gemini 不支持
      '$schema',        // JSON Schema 元字段，Gemini 不支持
      '$id',            // JSON Schema 元字段，Gemini 不支持
      '$ref',           // JSON Schema 引用字段，Gemini 不支持
      'definitions',    // JSON Schema 定义字段，Gemini 不支持
      'allOf',          // JSON Schema 组合字段，部分情况下不支持
      'oneOf',          // JSON Schema 组合字段，部分情况下不支持
      'anyOf',          // JSON Schema 组合字段，部分情况下不支持
      'not',            // JSON Schema 否定字段，Gemini 不支持
      'const',          // JSON Schema 常量字段，Gemini 不支持
      'if',             // JSON Schema 条件字段，Gemini 不支持
      'then',           // JSON Schema 条件字段，Gemini 不支持
      'else',           // JSON Schema 条件字段，Gemini 不支持
      'dependentSchemas', // JSON Schema 依赖字段，Gemini 不支持
      'dependentRequired', // JSON Schema 依赖字段，Gemini 不支持
      'patternProperties', // JSON Schema 模式属性字段，Gemini 不支持
      'additionalProperties', // JSON Schema 附加属性字段，部分情况下不支持
      'unevaluatedProperties', // JSON Schema 未评估属性字段，Gemini 不支持
      'contains',       // JSON Schema 数组包含字段，Gemini 不支持
      'minContains',    // JSON Schema 数组最小包含字段，Gemini 不支持
      'maxContains',    // JSON Schema 数组最大包含字段，Gemini 不支持
      'uniqueItems',    // JSON Schema 唯一项字段，Gemini 不支持
      'contentEncoding', // JSON Schema 内容编码字段，Gemini 不支持
      'contentMediaType', // JSON Schema 内容媒体类型字段，Gemini 不支持
      'contentSchema',  // JSON Schema 内容 schema 字段，Gemini 不支持
      'title',          // JSON Schema 标题字段，部分情况下不支持
      'examples',       // JSON Schema 示例字段，Gemini 不支持
      'default',        // JSON Schema 默认值字段，Gemini 不支持
      'readOnly',       // JSON Schema 只读字段，Gemini 不支持
      'writeOnly',      // JSON Schema 只写字段，Gemini 不支持
      'deprecated',     // JSON Schema 已弃用字段，Gemini 不支持
    ];
  }

  async transformRequestIn(request, provider, context) {
    // 深度克隆请求，避免修改原始对象
    const transformedRequest = JSON.parse(JSON.stringify(request));

    // 过滤工具参数中的不支持字段
    if (Array.isArray(transformedRequest.tools)) {
      transformedRequest.tools = transformedRequest.tools.map(tool => {
        if (tool.function && tool.function.parameters) {
          tool.function.parameters = this.cleanSchema(tool.function.parameters);
        }
        return tool;
      });
    }

    return transformedRequest;
  }

  async transformResponseOut(response) {
    // 直接返回响应，不做任何修改
    return response;
  }

  /**
   * 递归清理 JSON Schema，移除不支持的字段
   */
  cleanSchema(schema) {
    if (!schema || typeof schema !== 'object') {
      return schema;
    }

    // 处理数组
    if (Array.isArray(schema)) {
      return schema.map(item => this.cleanSchema(item));
    }

    // 处理对象
    const cleaned = {};
    for (const [key, value] of Object.entries(schema)) {
      // 跳过不支持的字段
      if (this.unsupportedFields.includes(key)) {
        continue;
      }

      // 递归处理嵌套对象
      cleaned[key] = this.cleanSchema(value);
    }

    return cleaned;
  }
};