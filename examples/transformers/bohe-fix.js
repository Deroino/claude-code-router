module.exports = class BoheFixTransformer {
  name = "bohe-fix";

  async transformRequestIn(request, provider) {
    const body = typeof request === "string" ? JSON.parse(request) : { ...request };

    if (body.tools && Array.isArray(body.tools)) {
      for (const tool of body.tools) {
        if (tool.function && tool.function.parameters) {
          // 清理元数据字段
          delete tool.function.parameters.additionalProperties;
          delete tool.function.parameters.$schema;

          // 添加 custom.input_schema 到工具根级别
          tool.custom = {
            input_schema: tool.function.parameters
          };
        }
      }
    }

    // 在请求体根级别也添加 custom 字段
    body.custom = {
      input_schema: {}
    };

    return body;
  }
};