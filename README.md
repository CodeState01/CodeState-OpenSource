# CodeState

Um espaço colaborativo em português com chat em tempo real, servidores e canais, editor multilíngue, assistente de IA e chamadas WebRTC com voz, vídeo e compartilhamento de tela.

![Node.js](https://img.shields.io/badge/Node.js-24%2B-5fa04e) ![Status](https://img.shields.io/badge/status-Beta-f4f4f4)

## Recursos

- Chat ao vivo via Server-Sent Events, com presença, indicador de digitação, reações e histórico em SQLite.
- Pedidos de amizade com aceite, conversas privadas, arquivos privados, respostas vinculadas à mensagem original e encaminhamento para canais ou contatos.
- Servidores privados com foto, fontes, convites HTTPS, cargos e canais com VFX opcional.
- Envio em fluxo de fotos, vídeos, áudio e arquivos de até 100 MB, com controle de acesso e cota configurável.
- Playground para HTML, CSS, JavaScript, Python, C#, C++ e Luau, com prévia web e prévia estrutural de interfaces Tkinter/PyQt, WinForms/WPF, Qt/ImGui e Roblox UI.
- Diagnóstico de sintaxe nas sete linguagens; o aplicativo local usa Node.js, Python, .NET e G++ instalados sem executar o código analisado.
- Canais de código com propostas revisadas e aceitas ou recusadas pelo dono do servidor.
- Respostas longas e códigos da IA em painéis expansíveis; o código pode ser editado e aplicado ao arquivo correspondente.
- Área de apoio para Skills, Agents e MCPs, com contexto enviado à IA sem expor segredos no navegador.
- CodeState AI com memória persistente por usuário, OpenAI e três opções gratuitas: Ollama local, OpenRouter Free e Groq.
- Perfil editável com nome, foto e banner em PNG, JPG, WebP ou GIF animado.
- Chamadas WebRTC com microfone, câmera e compartilhamento de tela; se a conexão direta de tela for bloqueada entre redes, o aplicativo usa quadros comprimidos por HTTPS sem armazená-los. O `.exe` usa o seletor nativo de tela do sistema.
- Interface responsiva, navegação por teclado, loaders personalizados e tema escuro em português.
- Canal inicial de apresentação somente leitura, aceite obrigatório dos Termos e avisos claros sobre as limitações e a espera da IA Beta.
- Conta automática no primeiro acesso: o servidor cria username e senha fortes, guarda as credenciais no dispositivo, mantém a sessão por um ano e recupera a identidade quando o banco gratuito reinicia. Nome de exibição e username continuam editáveis.
- Conta oficial opcional com cargo global e visível `CREATOR` em todos os servidores existentes e futuros.

## Executar

Requer Node.js 24 ou superior.

```bash
cp .env.example .env
npm start
```

Abra `http://localhost:3000`. Para usar um LLM gratuito sem enviar dados para outro serviço, instale o [Ollama](https://docs.ollama.com/api/chat), execute `ollama pull gemma3:4b` e mantenha-o ativo. Também há suporte ao [`openrouter/free`](https://openrouter.ai/docs/cookbook/get-started/free-models-router-playground) e à [Groq](https://console.groq.com/docs/api-reference); ambos exigem chaves próprias e aplicam limites de uso.

```env
OPENAI_API_KEY=sua_chave
OPENAI_MODEL=gpt-5
OLLAMA_URL=http://127.0.0.1:11434
OLLAMA_MODEL=gemma3:4b
OPENROUTER_API_KEY=sua_chave_gratuita
OPENROUTER_MODEL=openrouter/free
GROQ_API_KEY=sua_chave_gratuita
GROQ_MODEL=llama-3.3-70b-versatile
```

## Produção

O instalador Windows verifica novas versões publicadas em `CodeState01/codestate` e instala a atualização após confirmação. Para conectar vários amigos ao mesmo workspace, inicie o aplicativo com `--server=https://seu-servidor.com` ou defina `CODESTATE_SERVER_URL`; o endereço remoto precisa usar HTTPS. `ORBIT_SERVER_URL` continua aceito apenas para instalações antigas.

Defina `PUBLIC_APP_URL=https://app.seu-dominio.com` no servidor publicado. Os convites passam a usar esse domínio; IPs, `localhost` e domínios `.local` são rejeitados. Sem essa variável, o aplicativo mostra somente o código de convite para evitar gerar um link local quebrado.

O arquivo `render.yaml` prepara uma implantação gratuita chamada `codestate-community`. O Render fornece automaticamente um endereço `*.onrender.com`; `scripts/start-public.mjs` usa esse endereço em todos os convites e inicia o serviço em `0.0.0.0`. A conta automática pode ser recriada com as credenciais salvas no dispositivo quando o Render reiniciar. A camada gratuita continua com disco temporário, então servidores privados, mensagens e anexos podem ser apagados; para preservar esse conteúdo, conecte armazenamento e banco persistentes antes de divulgar amplamente.

O aplicativo instalado usa `https://codestate-community.onrender.com` por padrão. Argumentos `--server` e `CODESTATE_SERVER_URL` continuam tendo prioridade para ambientes próprios.

Use HTTPS e configure `APP_ORIGIN` com a origem exata. A tela possui compatibilidade HTTPS com quadros comprimidos que não são armazenados. Defina um servidor TURN para áudio, câmera e tela em alta qualidade entre redes corporativas, celulares e NATs restritivos:

```env
NODE_ENV=production
APP_ORIGIN=https://seu-dominio.com
HOST=0.0.0.0
TURN_URL=turn:turn.seu-dominio.com:3478
TURN_USERNAME=usuario
TURN_CREDENTIAL=segredo
```

O diretório `data/` contém contas, sessões, mensagens, projetos e anexos e está ignorado pelo Git. Faça backups dele e restrinja o acesso no servidor. Ajuste `MAX_UPLOAD_MB` e `MAX_USER_STORAGE_MB` conforme o espaço disponível. Um proxy reverso deve aceitar esse tamanho, limitar requisições e encerrar TLS. Para uso público amplo, troque o armazenamento de sinalização em memória por Redis e use um banco gerenciado.

Convites pertencem ao servidor salvo no banco e não à versão do `.exe`. Mantendo o mesmo `DATA_DIR` e `PUBLIC_APP_URL`, o link continua válido após reinícios e atualizações até que o dono o renove. Em produção, aponte `DATA_DIR` para um volume persistente e inclua esse volume nos backups.

Para criar a conta administrativa global sem publicar senha no repositório, execute `node scripts/generate-creator-credentials.mjs`, guarde a senha exibida e configure `CREATOR_USERNAME`, `CREATOR_PASSWORD_HASH` e `CREATOR_NAME` como variáveis secretas do serviço. A senha em texto não deve entrar no Git.

## Segurança

- Cookies `HttpOnly`, `SameSite=Strict` e `Secure` em produção.
- Tokens CSRF, validação de origem e bloqueio de requisições entre sites.
- Hash de senha com `scrypt` e comparação resistente a ataques de tempo.
- Controle de acesso por membro para mensagens, histórico, chamadas e sinalização.
- Limites por IP e usuário em login, cadastro, chat, IA e WebRTC.
- CSP, HSTS em produção, `nosniff`, política de permissões e prévia sem scripts.
- A resposta da IA usa `store: false`; código do Playground só é enviado quando o usuário inclui esse contexto.

Consulte [SECURITY.md](SECURITY.md) para relatar uma vulnerabilidade de forma responsável.

## Testes

```bash
npm test
npm run check
```

## Licença

Código-fonte privado. Todos os direitos reservados; consulte [LICENSE](LICENSE).
