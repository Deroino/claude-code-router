/**
 * Bohe-Claude Transformer
 *
 * This transformer is specifically designed to clean JSON Schema fields
 * that are not supported by the Bohe (薄荷公益) provider when using Claude models.
 * It removes unsupported fields like 'const', 'anyOf', etc. from tool definitions.
 */

module.exports = class BoheClaudeTransformer {
  static TransformerName = "bohe-claude";

  constructor(options = {}) {
    this.name = 'bohe-claude';
    // JSON Schema fields not supported by Bohe provider for Claude models
    this.unsupportedFields = options.unsupportedFields || [
      'propertyNames',  // Property name validation field
      '$schema',        // JSON Schema meta field
      '$id',            // JSON Schema meta field
      '$ref',           // JSON Schema reference field
      'definitions',    // JSON Schema definition field
      'allOf',          // JSON Schema composition field
      'all_of',         // JSON Schema composition field (snake_case)
      'oneOf',          // JSON Schema composition field
      'one_of',         // JSON Schema composition field (snake_case)
      'anyOf',          // JSON Schema composition field - NOT SUPPORTED
      'any_of',         // JSON Schema composition field (snake_case) - NOT SUPPORTED
      'not',            // JSON Schema negation field
      'const',          // JSON Schema constant field - NOT SUPPORTED
      'if',             // JSON Schema conditional field
      'then',           // JSON Schema conditional field
      'else',           // JSON Schema conditional field
      'dependentSchemas', // JSON Schema dependency field
      'dependent_schemas', // JSON Schema dependency field (snake_case)
      'dependentRequired', // JSON Schema dependency field
      'dependent_required', // JSON Schema dependency field (snake_case)
      'patternProperties', // JSON Schema pattern properties field
      'pattern_properties', // JSON Schema pattern properties field (snake_case)
      'additionalProperties', // JSON Schema additional properties field
      'additional_properties', // JSON Schema additional properties field (snake_case)
      'unevaluatedProperties', // JSON Schema unevaluated properties field
      'unevaluated_properties', // JSON Schema unevaluated properties field (snake_case)
      'contains',       // JSON Schema array contains field
      'minContains',    // JSON Schema array min contains field
      'min_contains',   // JSON Schema array min contains field (snake_case)
      'maxContains',    // JSON Schema array max contains field
      'max_contains',   // JSON Schema array max contains field (snake_case)
      'uniqueItems',    // JSON Schema unique items field
      'unique_items',   // JSON Schema unique items field (snake_case)
      'contentEncoding', // JSON Schema content encoding field
      'content_encoding', // JSON Schema content encoding field (snake_case)
      'contentMediaType', // JSON Schema content media type field
      'content_media_type', // JSON Schema content media type field (snake_case)
      'contentSchema',  // JSON Schema content schema field
      'content_schema',  // JSON Schema content schema field (snake_case)
      'title',          // JSON Schema title field
      'examples',       // JSON Schema examples field
      'default',        // JSON Schema default field
      'readOnly',       // JSON Schema read-only field
      'read_only',      // JSON Schema read-only field (snake_case)
      'writeOnly',      // JSON Schema write-only field
      'write_only',      // JSON Schema write-only field (snake_case)
      'deprecated',     // JSON Schema deprecated field
    ];
  }

  async transformRequestIn(request, provider, context) {
    // Deep clone request to avoid modifying original object
    const transformedRequest = JSON.parse(JSON.stringify(request));

    // Debug: Log the request before transformation
    console.log('[bohe-claude] Input request:', JSON.stringify(transformedRequest, null, 2).substring(0, 2000));

    // Handle OpenAI format tools
    if (Array.isArray(transformedRequest.tools)) {
      transformedRequest.tools = transformedRequest.tools.map(tool => {
        if (tool.function && tool.function.parameters) {
          // Clean unsupported fields from parameters
          const cleanedParams = this.cleanSchema(tool.function.parameters);

          // Add custom.input_schema to tool root level (required by Bohe)
          tool.custom = {
            input_schema: cleanedParams
          };
        }
        return tool;
      });
    }

    // Handle Gemini format tools (function_declarations)
    // This is the format used by Bohe provider
    if (transformedRequest.tools && Array.isArray(transformedRequest.tools)) {
      for (const tool of transformedRequest.tools) {
        if (tool.functionDeclarations && Array.isArray(tool.functionDeclarations)) {
          tool.functionDeclarations = tool.functionDeclarations.map(decl => {
            if (decl.parameters) {
              decl.parameters = this.cleanSchema(decl.parameters);
            }
            return decl;
          });
        }
        // Also handle snake_case variant
        if (tool.function_declarations && Array.isArray(tool.function_declarations)) {
          tool.function_declarations = tool.function_declarations.map(decl => {
            if (decl.parameters) {
              decl.parameters = this.cleanSchema(decl.parameters);
            }
            return decl;
          });
        }
      }
    }

    // Add custom.input_schema at request body root level (required by Bohe)
    transformedRequest.custom = {
      input_schema: {}
    };

    // Debug: Log the request after transformation
    console.log('[bohe-claude] Output request:', JSON.stringify(transformedRequest, null, 2).substring(0, 2000));

    return transformedRequest;
  }

  async transformResponseOut(response) {
    // Return response without any modifications
    return response;
  }

  /**
   * Recursively clean JSON Schema, removing unsupported fields
   */
  cleanSchema(schema) {
    if (!schema || typeof schema !== 'object') {
      return schema;
    }

    // Handle arrays
    if (Array.isArray(schema)) {
      return schema.map(item => this.cleanSchema(item));
    }

    // Handle objects
    const cleaned = {};
    for (const [key, value] of Object.entries(schema)) {
      // Skip unsupported fields
      if (this.unsupportedFields.includes(key)) {
        continue;
      }

      // Recursively process nested objects
      cleaned[key] = this.cleanSchema(value);
    }

    return cleaned;
  }
};