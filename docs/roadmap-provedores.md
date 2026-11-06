# Roadmap de provedores — integração com sites de chat de IA

O Proxy IA integra os sites de chat listados abaixo. Cada integração segue o
[guia de novos provedores](guia-novos-provedores.md): inspeção do site, adaptador
no contrato comum, registro em todas as camadas, login pela tela remota do painel
e validação real com um ciclo de ferramenta de IDE.

Status em 2026-11-06. Legenda:

- ✅ integrado e validado com conta real
- 🟡 implementado (adaptador, login pelo painel, testes com frontend simulado);
  falta validar login, envio real e ciclo de ferramenta com conta real
- ⬜ não iniciado

## Status

| Empresa (produto) | Site informado | URL do chat usada | ID | Modelos | Status | Documentação |
| --- | --- | --- | --- | --- | --- | --- |
| OpenAI (ChatGPT) | chatgpt.com | https://chatgpt.com | `chatgpt` | `chatgpt/<id>` | ✅ | [chatgpt-integration.md](chatgpt-integration.md). Conta Plus validada; falta conta Free. |
| DeepSeek | chatdeepseek.com | https://chat.deepseek.com | `deepseek` | `deepseek-v4-*` | ✅ | Provedor padrão, em produção. |
| Alibaba (Qwen) | chat.qwenlm.ai | https://chat.qwen.ai | `qwen` | `qwen/<id>` | ✅ | README e `src/providers/QWEN-NOTICE`. |
| Anthropic (Claude) | claude.ai | https://claude.ai | `claude` | `claude/auto`, `claude/<id>` | 🟡 | [claude-integration.md](claude-integration.md) |
| Google (Gemini) | google.com | https://gemini.google.com/app | `gemini` | `gemini/auto`, `gemini/<modo>` | 🟡 | [gemini-integration.md](gemini-integration.md) |
| Microsoft (Copilot) | microsoft.com | https://copilot.microsoft.com/chats/new | `copilot` | `copilot/auto`, `copilot/<modo>` | 🟡 | [copilot-integration.md](copilot-integration.md) |
| Mistral AI (Vibe, antigo Le Chat) | chat.mistral.ai | https://chat.mistral.ai/chat | `mistral` | `mistral/fast`, `mistral/think` | 🟡 | [mistral-integration.md](mistral-integration.md) |
| xAI (Grok) | grok.com | https://grok.com | `grok` | `grok/auto`, `grok/<modo>` | 🟡 | [grok-integration.md](grok-integration.md) |
| Meta (Meta AI) | meta.ai | https://www.meta.ai | `meta` | `meta/auto`, `meta/think_*` | 🟡 | [meta-integration.md](meta-integration.md) |
| Cohere (Command) | cohere.com | https://dashboard.cohere.com/playground/chat | `cohere` | `cohere/<id>` | 🟡 | [cohere-integration.md](cohere-integration.md) |
| Perplexity AI (Sonar) | perplexity.ai | https://www.perplexity.ai | `perplexity` | `perplexity/auto`, `perplexity/<id>` | 🟡 | [perplexity-integration.md](perplexity-integration.md) |
| Moonshot AI (Kimi Chat) | kimi.ai | https://www.kimi.ai | `kimi` | `kimi/<id>` (hoje `kimi/k2d6-chat`) | 🟡 | [kimi-integration.md](kimi-integration.md) |
| QuillBot (QuillBot Chat) | quillbot.com | https://quillbot.com/ai-chat | `quillbot` | `quillbot/chat` | 🟡 | [quillbot-integration.md](quillbot-integration.md) |
| Baidu (Ernie Bot) | baidu.com | https://wenxin.baidu.com | `ernie` | `ernie/smartMode`, `ernie/ERINE-5.1` | 🟡 | [ernie-integration.md](ernie-integration.md) |

Observações sobre as URLs:

- `copilot.microsoft.com/` redireciona para uma página de marketing; o proxy usa `/chats/new`.
- `chat.cohere.com` e `coral.cohere.com` redirecionam para o dashboard; o chat é o playground.
- `kimi.ai` usa a versão internacional (`www.kimi.ai`); `www.kimi.com` exibe o login da China continental.
- `yiyan.baidu.com` redireciona para `wenxin.baidu.com`; o login exige conta Baidu, possivelmente com telefone chinês.

## Como os 11 novos provedores funcionam

- Login: o painel abre o site na tela remota do worker e o usuário clica em **Concluir login**
  depois de entrar. Nenhum provedor novo faz login automático.
- Envio: o adaptador opera o compositor do próprio site e captura só a resposta do prompt enviado.
  Gemini e Meta AI devolvem a resposta inteira no fim (sem streaming incremental).
- Somente texto: mensagens com imagens e `reasoning_effort` são recusadas com 400; o modo de
  raciocínio é escolhido pelo modelo (por exemplo `mistral/think`).
- Banco: a migração 6 cria uma conta de cada provedor novo para os usuários existentes.

## Pendências comuns antes de marcar ✅

Cada documento de integração lista os detalhes. Em todos os provedores 🟡 falta:

1. Login real pela tela remota do worker, passando pelo proxy de saída (Squid), e `squid -k parse`.
2. Confirmar os seletores e a detecção de sessão válida/expirada com conta logada.
3. Envio normal e em streaming pelo worker e pelo gateway com chave `dsp_`
   (`npx tsx scripts/smoke-<id>.ts`).
4. Ciclo completo de ferramenta de IDE.
5. Mensagens reais de limite de uso, conta bloqueada e desafios anti-bot (Cloudflare, hCaptcha, Baidu).

## Checklist por provedor

- [ ] Inspeção autenticada do HTML e da rede (compositor, envio, parada, modelos, limites)
- [ ] Adaptador em `src/providers/<id>*.ts`, seguindo `src/providers/types.ts`
- [ ] `ProviderId` registrado em `types.ts`, `catalog.ts` e `registry.ts`
- [ ] Listas compartilhadas: `providers` (`src/production/database.ts`), `manualLoginProviders`
      (`src/production/gateway.ts`), `textOnlyWebProviders` (`src/routes/chat.ts`)
- [ ] Painel, provisionamento e backup (`src/production/`, `public/panel.js`, `deploy/`)
- [ ] Testes em `src/<id>.test.ts`, incluindo compatibilidade de ferramentas
- [ ] Envio real autenticado e ciclo completo de ferramenta pelo worker
- [ ] Documentação em `docs/<id>-integration.md` com o que foi e o que não foi testado
- [ ] Status atualizado nesta página
