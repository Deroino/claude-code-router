/**
 * Bohe-Claude Transformer
 * 
 * 这个 transformer 专门用于为 Claude API 添加缺失的 custom.input_schema 字段
 * 解决 "custom.input_schema: Field required" 错误
 */

module.exports = class BoheClaudeTransformer {
  static TransformerName = "bohe-claude";

  constructor(options = {}) {
    this.name = 'bohe-claude';
    // 是否启用详细日志
    this.debug = options.debug || false;
  }

  async transformRequestIn(request, provider, context) {
    // 深度克隆请求，避免修改原始对象
    const transformedRequest = JSON.parse(JSON.stringify(request));

    // 添加 custom.input_schema 字段
    if (!transformedRequest.custom) {
      transformedRequest.custom = {};
    }

    // 如果没有 input_schema，创建一个空的 schema
    if (!transformedRequest.custom.input_schema) {
      transformedRequest.custom.input_schema = {
        type: "object",
        properties: {},
      };

      if (this.debug) {
        console.log('[BoheClaudeTransformer] Added custom.input_schema field');
      }
    }

    return transformedRequest;
  }

  async transformResponseOut(response) {
    // 直接返回响应，不做任何修改
    return response;
  }
};