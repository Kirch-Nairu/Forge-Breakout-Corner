'use strict';

const { fetchJson } = require('../lib/http');

function isLoopbackUrl(input) {
  const url = new URL(input);
  return ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname);
}

class LlamaClient {
  constructor(config) {
    this.config = config;
    if (!config.allowRemote && !isLoopbackUrl(config.baseUrl)) {
      throw new Error('Remote LLM endpoint refused. Set KIRION_ALLOW_REMOTE_LLM=1 only when intentional.');
    }
  }

  async completeJson({ role, system, messages = [], schema, schemaName = 'kirion_output', maxTokens = null }) {
    const body = {
      model: this.config.model,
      messages: [
        { role: 'system', content: `[KIRION ROLE: ${role}]\n${system}` },
        ...messages
      ],
      temperature: 0.1,
      max_tokens: maxTokens || this.config.maxOutputTokens,
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: schemaName,
          strict: true,
          schema
        }
      }
    };

    const result = await fetchJson(
      `${this.config.baseUrl.replace(/\/$/, '')}/chat/completions`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
      },
      this.config.timeoutMs
    );

    const content = result?.choices?.[0]?.message?.content;
    if (typeof content !== 'string') throw new Error('LLM returned no textual content.');
    try {
      return { data: JSON.parse(content), usage: result.usage || null, raw: result };
    } catch (err) {
      const parseErr = new Error('LLM response violated JSON contract.');
      parseErr.cause = err;
      parseErr.content = content;
      throw parseErr;
    }
  }
}

module.exports = { LlamaClient, isLoopbackUrl };
