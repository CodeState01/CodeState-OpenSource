# Política de segurança

## Versões suportadas

A versão mais recente da branch `main` recebe correções de segurança.

## Relatar uma vulnerabilidade

Não abra uma issue pública com detalhes exploráveis. Use o recurso **Security advisories → Report a vulnerability** do repositório no GitHub. Inclua o impacto, os passos mínimos para reproduzir e uma sugestão de correção, se tiver.

Evite acessar dados de terceiros, interromper o serviço ou realizar testes destrutivos. A confirmação inicial será feita assim que possível e a correção será coordenada antes da divulgação.

## Modelo de ameaça e limites

O Orbit Studio protege a chave da OpenAI no servidor, isola a prévia de código e verifica a associação ao servidor antes de liberar mensagens ou sinais WebRTC. O conteúdo das mensagens fica no banco SQLite local sem criptografia em repouso; proteja o volume e os backups com os controles da hospedagem.

WebRTC cifra mídia durante o transporte. O servidor de sinalização não recebe o fluxo de áudio ou vídeo, mas participantes de uma chamada ainda podem gravar a tela por meios externos. Um TURN retransmite mídia quando a conexão direta falha e deve ser operado por uma parte confiável.
