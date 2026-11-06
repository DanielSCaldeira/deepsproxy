const actionableErrorFields = {
  original_message: { type: 'string', nullable: true, description: 'Original upstream error when available; null if it was not captured.' },
  user_action: { type: 'string', description: 'Instructions for resolving the error.' },
  help_url: { type: 'string', format: 'uri', nullable: true, description: 'Direct link when the user needs to visit a site.' },
  suspended_until: { type: 'string', description: 'Suspension deadline as displayed by DeepSeek; timezone may be unspecified.' },
  retry_at: { type: 'string', format: 'date-time', nullable: true },
};

export const openApiSpec = {
  openapi: '3.0.0',
  info: {
    title: 'Proxy IA API',
    version: '1.0.0',
    description:
      'OpenAI-compatible proxy for DeepSeek, Qwen, ChatGPT, Claude, Gemini, Copilot, Mistral, Grok, Meta AI, Cohere, Perplexity, Kimi, QuillBot and Ernie web models via browser automation. ' +
      'Supports streaming, tool calling, and thinking models.',
  },
  servers: [{ url: '/' }],
  components: {
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer' },
      apiKeyHeader: { type: 'apiKey', in: 'header', name: 'X-API-Key' },
    },
    responses: {
      Unauthorized: {
        description: 'Missing or invalid API key',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: { error: { type: 'string', example: 'Unauthorized' } },
            },
          },
        },
      },
    },
    schemas: {
      ActionableError: {
        type: 'object', properties: { error: { type: 'object', properties: {
          message: { type: 'string', description: 'Error, user instructions and relevant link in one displayable message.' },
          type: { type: 'string' }, code: { type: 'string' }, ...actionableErrorFields,
        } } },
      },
      Model: {
        type: 'object',
        properties: {
          id: { type: 'string', example: 'deepseek-v4-flash' },
          object: { type: 'string', example: 'model' },
          created: { type: 'integer', example: 1700000000 },
          owned_by: { type: 'string', example: 'deepseek' },
          context_length: { type: 'integer', example: 65536 },
          max_context_tokens: { type: 'integer', example: 65536 },
          max_input_tokens: { type: 'integer', example: 65536 },
          max_output_tokens: { type: 'integer', example: 8000 },
          context_limit_source: { type: 'string', enum: ['configured_or_estimated', 'unknown'] },
        },
      },
      Message: {
        type: 'object',
        required: ['role', 'content'],
        properties: {
          role: {
            type: 'string',
            enum: ['system', 'user', 'assistant', 'tool'],
            example: 'user',
          },
          content: {
            nullable: true,
            oneOf: [
              { type: 'string', example: 'Hello!' },
              { type: 'null' },
            ],
          },
          tool_calls: {
            type: 'array',
            items: { $ref: '#/components/schemas/MessageToolCall' },
          },
          tool_call_id: { type: 'string', example: 'call_abc123' },
          name: { type: 'string' },
          reasoning_content: { type: 'string' },
        },
      },
      MessageToolCall: {
        type: 'object',
        required: ['id', 'type', 'function'],
        properties: {
          id: { type: 'string', example: 'call_abc123' },
          type: { type: 'string', enum: ['function'] },
          function: {
            type: 'object',
            required: ['name', 'arguments'],
            properties: {
              name: { type: 'string', example: 'get_weather' },
              arguments: { type: 'string', example: '{"location":"São Paulo"}' },
            },
          },
        },
      },
      FunctionToolDefinition: {
        type: 'object',
        required: ['type', 'function'],
        properties: {
          type: { type: 'string', enum: ['function'] },
          function: {
            type: 'object',
            required: ['name'],
            properties: {
              name: { type: 'string', example: 'get_weather' },
              description: { type: 'string', example: 'Get current weather for a location' },
              parameters: {
                type: 'object',
                description: 'JSON Schema for the function parameters',
                example: {
                  type: 'object',
                  properties: { location: { type: 'string' } },
                  required: ['location'],
                },
              },
              strict: { type: 'boolean' },
            },
          },
        },
      },
      ChatCompletionRequest: {
        type: 'object',
        required: ['model', 'messages'],
        properties: {
          model: {
            type: 'string',
            enum: [
              'deepseek-v4-flash',
              'deepseek-v4-flash-thinking',
              'deepseek-v4-pro',
              'deepseek-v4-pro-thinking',
            ],
            example: 'deepseek-v4-flash',
          },
          messages: {
            type: 'array',
            items: { $ref: '#/components/schemas/Message' },
            example: [
              { role: 'system', content: 'You are a helpful assistant.' },
              { role: 'user', content: 'What is 2+2?' },
            ],
          },
          stream: { type: 'boolean', default: false },
          tools: {
            type: 'array',
            items: { $ref: '#/components/schemas/FunctionToolDefinition' },
          },
          tool_choice: {
            oneOf: [
              { type: 'string', enum: ['auto', 'none', 'required'] },
              {
                type: 'object',
                properties: {
                  type: { type: 'string', enum: ['function'] },
                  function: {
                    type: 'object',
                    properties: { name: { type: 'string' } },
                  },
                },
              },
            ],
          },
        },
      },
      Usage: {
        type: 'object',
        properties: {
          prompt_tokens: { type: 'integer', example: 20 },
          completion_tokens: { type: 'integer', example: 10 },
          total_tokens: { type: 'integer', example: 30 },
          prompt_tokens_details: {
            type: 'object',
            properties: { cached_tokens: { type: 'integer', example: 0 } },
          },
        },
      },
      ChatCompletionResponse: {
        type: 'object',
        properties: {
          id: { type: 'string', example: 'chatcmpl-abc123' },
          object: { type: 'string', example: 'chat.completion' },
          created: { type: 'integer', example: 1700000000 },
          model: { type: 'string', example: 'deepseek-v4-flash' },
          choices: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                index: { type: 'integer', example: 0 },
                message: { $ref: '#/components/schemas/Message' },
                finish_reason: {
                  type: 'string',
                  nullable: true,
                  enum: ['stop', 'tool_calls', 'length', null],
                  example: 'stop',
                },
                logprobs: { nullable: true, type: 'object' },
              },
            },
          },
          usage: { $ref: '#/components/schemas/Usage' },
        },
      },
    },
  },
  paths: {
    '/health': {
      get: {
        tags: ['System'],
        summary: 'Health check',
        operationId: 'healthCheck',
        responses: {
          '200': {
            description: 'Server is healthy',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { status: { type: 'string', example: 'ok' } },
                },
              },
            },
          },
        },
      },
    },
    '/v1/models': {
      get: {
        tags: ['Models'],
        summary: 'List available models',
        operationId: 'listModels',
        security: [{ bearerAuth: [] }, { apiKeyHeader: [] }],
        responses: {
          '200': {
            description: 'List of available DeepSeek models',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    object: { type: 'string', example: 'list' },
                    data: { type: 'array', items: { $ref: '#/components/schemas/Model' } },
                  },
                },
              },
            },
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
        },
      },
    },
    '/v1/chat/completions': {
      post: {
        tags: ['Chat'],
        summary: 'Create chat completion',
        description:
          'OpenAI-compatible chat completion endpoint. Set `stream: true` for SSE streaming.',
        operationId: 'createChatCompletion',
        security: [{ bearerAuth: [] }, { apiKeyHeader: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ChatCompletionRequest' },
            },
          },
        },
        responses: {
          '200': {
            description: 'Non-streaming completion or SSE stream (when `stream: true`)',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ChatCompletionResponse' },
              },
              'text/event-stream': {
                schema: {
                  type: 'string',
                  description: 'SSE stream of `data: {...}` chunks, terminated with `data: [DONE]`. Failures after streaming starts emit an ActionableError envelope before [DONE].',
                },
              },
            },
          },
          '401': {
            description: 'Missing/invalid API key, or DeepSeek login required. Login errors include user instructions and a direct link.',
            content: { 'application/json': { schema: { oneOf: [
              { type: 'object', properties: { error: { type: 'string' } } },
              { $ref: '#/components/schemas/ActionableError' },
            ] } } },
          },
          '429': { description: 'DeepSeek rate limit; retry_at reports the next permitted attempt.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ActionableError' } } } },
          '403': {
            description: 'DeepSeek account is suspended',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    error: {
                      type: 'object',
                      properties: {
                        message: { type: 'string' },
                        type: { type: 'string', example: 'deepseek_account_suspended' },
                        code: { type: 'string', example: 'deepseek_account_suspended' },
                        ...actionableErrorFields,
                      },
                    },
                  },
                },
              },
            },
          },
          '409': {
            description: 'DeepSeek chat input is unavailable',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    error: {
                      type: 'object',
                      properties: {
                        message: { type: 'string' },
                        type: { type: 'string', example: 'deepseek_chat_unavailable' },
                        code: { type: 'string', example: 'deepseek_chat_unavailable' },
                        ...actionableErrorFields,
                      },
                    },
                  },
                },
              },
            },
          },
          '500': {
            description: 'Upstream error from DeepSeek',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    error: {
                      type: 'object',
                      properties: {
                        message: { type: 'string' },
                        type: { type: 'string', example: 'upstream_error' },
                        code: { type: 'string', example: 'upstream_error' },
                        ...actionableErrorFields,
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
};
