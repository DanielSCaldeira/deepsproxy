const apiBase = process.env.DEEPSPROXY_API_BASE || 'http://127.0.0.1:3000/v1';
const model = process.env.DEEPSPROXY_LIVE_TEST_MODEL || 'deepseek-v4-flash';
const expectedTag = 'NIMBO-7391';
const expectedComponent = 'Aurora';
const filler = ' Historical note: no additional requirement was decided in this sentence.';

function readSseCompletion(response: Response): Promise<string> {
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

    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6);
        if (data === '[DONE]') return content;
        const chunk = JSON.parse(data);
        const delta = chunk.choices?.[0]?.delta;
        if (typeof delta?.content === 'string') content += delta.content;
      }

      if (done) break;
    }

    return content;
  })();
}

async function request(messages: Array<{ role: string; content: string }>): Promise<string> {
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
  const longEarlierUserTurn = [
    `Decisão desta conversa: o identificador é ${expectedTag} e o componente escolhido se chama ${expectedComponent}. Guarde esses dois dados para a próxima pergunta.`,
    filler.repeat(180),
  ].join('\n');
  const longEarlierAssistantTurn = [
    `Entendido. A decisão registrada foi ${expectedTag} para o identificador e ${expectedComponent} para o componente.`,
    filler.repeat(180),
  ].join('\n');

  console.log(`Enviando turno 1 em streaming para ${apiBase} (${model})...`);
  const firstAnswer = await request([
    { role: 'system', content: 'Responda em português de forma concisa e use o histórico da conversa.' },
    { role: 'user', content: longEarlierUserTurn },
    { role: 'assistant', content: longEarlierAssistantTurn },
    { role: 'user', content: `Confirme brevemente que anotou a decisão ${expectedTag}.` },
  ]);
  console.log(`Resposta 1: ${firstAnswer.slice(0, 500)}`);

  console.log('Enviando turno 2 com o histórico completo, simulando o cliente Continue...');
  const secondAnswer = await request([
    { role: 'system', content: 'Responda em português de forma concisa e use o histórico da conversa.' },
    { role: 'user', content: longEarlierUserTurn },
    { role: 'assistant', content: longEarlierAssistantTurn },
    { role: 'user', content: `Confirme brevemente que anotou a decisão ${expectedTag}.` },
    { role: 'assistant', content: firstAnswer },
    { role: 'user', content: 'Qual identificador e nome de componente decidimos anteriormente?' },
  ]);
  console.log(`Resposta 2: ${secondAnswer.slice(0, 500)}`);

  if (!secondAnswer.includes(expectedTag) || !secondAnswer.includes(expectedComponent)) {
    throw new Error(`Conversation continuity check failed; expected ${expectedTag} and ${expectedComponent}.`);
  }

  console.log('Teste real aprovado: o segundo turno recuperou os dados do contexto antigo.');
}

main().catch((error: any) => {
  console.error(error?.message || String(error));
  process.exitCode = 1;
});
