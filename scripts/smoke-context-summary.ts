const apiBase = process.env.DEEPSPROXY_API_BASE || 'http://127.0.0.1:3000/v1';
const model = process.env.DEEPSPROXY_LIVE_TEST_MODEL || 'deepseek-v4-flash';
const expectedTag = 'NIMBO-7391';
const expectedComponent = 'Aurora';
const filler = ' Historical note: no additional requirement was decided in this sentence.';
const fillerRepeats = Number(process.env.DEEPSPROXY_LIVE_TEST_FILLER_REPEATS || '180');
const requireContextSummary = process.env.DEEPSPROXY_LIVE_TEST_REQUIRE_SUMMARY === '1';

interface LiveCompletion {
  content: string;
  promptTokens: number | null;
}

function readSseCompletion(response: Response): Promise<LiveCompletion> {
  if (!response.ok || !response.body) {
    return response.text().then((body) => {
      throw new Error(`Chat completion failed (${response.status}): ${body}`);
    });
  }

  return (async () => {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let content = '';
    let promptTokens: number | null = null;

    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6);
        if (data === '[DONE]') return { content, promptTokens };
        const chunk = JSON.parse(data);
        const delta = chunk.choices?.[0]?.delta;
        if (typeof delta?.content === 'string') content += delta.content;
        if (typeof chunk.usage?.prompt_tokens === 'number') promptTokens = chunk.usage.prompt_tokens;
      }

      if (done) break;
    }

    return { content, promptTokens };
  })();
}

async function request(messages: Array<{ role: string; content: string }>): Promise<LiveCompletion> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (process.env.DEEPSPROXY_API_KEY) {
    headers.Authorization = `Bearer ${process.env.DEEPSPROXY_API_KEY}`;
  }
  const response = await fetch(`${apiBase}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ model, messages, stream: true }),
  });
  return readSseCompletion(response);
}

async function main(): Promise<void> {
  if (!Number.isInteger(fillerRepeats) || fillerRepeats < 1 || fillerRepeats > 10_000) {
    throw new Error('DEEPSPROXY_LIVE_TEST_FILLER_REPEATS must be an integer between 1 and 10000.');
  }

  const longEarlierUserTurn = [
    `Decisão desta conversa: o identificador é ${expectedTag} e o componente escolhido se chama ${expectedComponent}. Guarde esses dois dados para a próxima pergunta.`,
    filler.repeat(fillerRepeats),
  ].join('\n');
  const longEarlierAssistantTurn = [
    `Entendido. A decisão registrada foi ${expectedTag} para o identificador e ${expectedComponent} para o componente.`,
    filler.repeat(fillerRepeats),
  ].join('\n');

  console.log(`Enviando turno 1 em streaming para ${apiBase} (${model}, fillerRepeats=${fillerRepeats})...`);
  const firstResult = await request([
    { role: 'system', content: 'Responda em português de forma concisa e use o histórico da conversa.' },
    { role: 'user', content: longEarlierUserTurn },
    { role: 'assistant', content: longEarlierAssistantTurn },
    { role: 'user', content: `Confirme brevemente que anotou a decisão ${expectedTag}.` },
  ]);
  const firstAnswer = firstResult.content;
  console.log(`Resposta 1 (prompt_tokens=${firstResult.promptTokens ?? 'indisponível'}): ${firstAnswer.slice(0, 500)}`);

  console.log('Enviando turno 2 com o histórico completo, simulando o cliente Continue...');
  const secondResult = await request([
    { role: 'system', content: 'Responda em português de forma concisa e use o histórico da conversa.' },
    { role: 'user', content: longEarlierUserTurn },
    { role: 'assistant', content: longEarlierAssistantTurn },
    { role: 'user', content: `Confirme brevemente que anotou a decisão ${expectedTag}.` },
    { role: 'assistant', content: firstAnswer },
    { role: 'user', content: 'Qual identificador e nome de componente decidimos anteriormente?' },
  ]);
  const secondAnswer = secondResult.content;
  console.log(`Resposta 2 (prompt_tokens=${secondResult.promptTokens ?? 'indisponível'}): ${secondAnswer.slice(0, 500)}`);

  if (!secondAnswer.includes(expectedTag) || !secondAnswer.includes(expectedComponent)) {
    throw new Error(`Conversation continuity check failed; expected ${expectedTag} and ${expectedComponent}.`);
  }

  if (requireContextSummary) {
    for (const [turn, result] of [['1', firstResult], ['2', secondResult]] as const) {
      if (result.promptTokens === null || result.promptTokens >= 100_000) {
        throw new Error(`Turn ${turn} was not compacted as expected; final prompt_tokens=${result.promptTokens ?? 'unavailable'}.`);
      }
    }
  }

  console.log('Teste real aprovado: o segundo turno recuperou os dados do contexto antigo.');
}

main().catch((error: any) => {
  console.error(error?.message || String(error));
  process.exitCode = 1;
});
